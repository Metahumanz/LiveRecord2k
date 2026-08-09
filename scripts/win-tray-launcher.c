#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif

#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <wininet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define IDI_APP_ICON 1
#define APP_NAME L"BiliRecord2K"
#define MUTEX_NAME L"Local\\BiliRecord2K.Tray"
#define WM_TRAYICON (WM_APP + 1)
#define WM_TRAY_POLL_COMPLETE (WM_APP + 2)
#define TIMER_POLL 1
#define TIMER_NOTIFICATION 3
#define TRAY_UID 1
#define MENU_OPEN 1001
#define MENU_EXIT 1002
#define DEFAULT_PORT 3263
#define COMMAND_CAPACITY 32768
#define HTTP_CAPACITY 65536
#define HTTP_CONNECT_TIMEOUT_MS 800
#define HTTP_SEND_TIMEOUT_MS 1000
#define HTTP_RECEIVE_TIMEOUT_MS 1000

#ifndef NIN_SELECT
#define NIN_SELECT (WM_USER + 0)
#endif

#ifndef NIN_KEYSELECT
#define NIN_KEYSELECT (WM_USER + 1)
#endif

#ifndef NIF_SHOWTIP
#define NIF_SHOWTIP 0x00000080
#endif

static HINSTANCE g_instance;
static HWND g_window;
static HWND g_notification_popup;
static NOTIFYICONDATAW g_tray;
static HANDLE g_service_process;
static int g_port = DEFAULT_PORT;
static DWORD g_last_notification_seq = 0;
static DWORD g_last_open_tick = 0;
static volatile LONG g_poll_in_progress = 0;
static wchar_t g_notification_title[128] = L"";
static wchar_t g_notification_message[256] = L"";

typedef struct TrayPollRequest {
  HWND window;
  DWORD after_seq;
} TrayPollRequest;

typedef struct TrayPollResult {
  int ok;
  char response[HTTP_CAPACITY];
} TrayPollResult;

static int append_space_if_needed(wchar_t *buffer, size_t capacity) {
  size_t length = wcslen(buffer);
  if (length == 0) {
    return 1;
  }
  if (length + 1 >= capacity) {
    return 0;
  }
  buffer[length] = L' ';
  buffer[length + 1] = L'\0';
  return 1;
}

static int append_char(wchar_t *buffer, size_t capacity, wchar_t value) {
  size_t length = wcslen(buffer);
  if (length + 1 >= capacity) {
    return 0;
  }
  buffer[length] = value;
  buffer[length + 1] = L'\0';
  return 1;
}

static int append_quoted_arg(wchar_t *buffer, size_t capacity, const wchar_t *arg) {
  if (!append_space_if_needed(buffer, capacity)) {
    return 0;
  }
  if (!append_char(buffer, capacity, L'"')) {
    return 0;
  }
  for (const wchar_t *cursor = arg; *cursor; cursor++) {
    if (*cursor == L'"' && !append_char(buffer, capacity, L'\\')) {
      return 0;
    }
    if (!append_char(buffer, capacity, *cursor)) {
      return 0;
    }
  }
  return append_char(buffer, capacity, L'"');
}

static void show_error(const wchar_t *message, DWORD code) {
  wchar_t buffer[1024];
  swprintf(buffer, 1024, L"%ls\n\n错误码：%lu", message, code);
  MessageBoxW(NULL, buffer, APP_NAME, MB_OK | MB_ICONERROR);
}

static int read_text_file(const wchar_t *path, char *buffer, DWORD capacity) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    return 0;
  }
  DWORD read_bytes = 0;
  BOOL ok = ReadFile(file, buffer, capacity - 1, &read_bytes, NULL);
  CloseHandle(file);
  if (!ok) {
    return 0;
  }
  buffer[read_bytes] = '\0';
  return 1;
}

static int parse_saved_port(void) {
  wchar_t appdata[MAX_PATH];
  if (!GetEnvironmentVariableW(L"APPDATA", appdata, MAX_PATH)) {
    return DEFAULT_PORT;
  }

  wchar_t settings_path[MAX_PATH];
  swprintf(settings_path, MAX_PATH, L"%ls\\BiliRecord2K\\settings.json", appdata);

  char buffer[8192];
  if (!read_text_file(settings_path, buffer, sizeof(buffer))) {
    return DEFAULT_PORT;
  }

  const char *key = strstr(buffer, "\"serverPort\"");
  if (!key) {
    return DEFAULT_PORT;
  }
  const char *colon = strchr(key, ':');
  if (!colon) {
    return DEFAULT_PORT;
  }
  int port = atoi(colon + 1);
  if (port < 1 || port > 65535) {
    return DEFAULT_PORT;
  }
  return port;
}

static int resolve_port_from_args(void) {
  int port = parse_saved_port();
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) {
    return port;
  }
  for (int index = 1; index < argc; index++) {
    if (wcsncmp(argv[index], L"--port=", 7) == 0) {
      int candidate = _wtoi(argv[index] + 7);
      if (candidate >= 1 && candidate <= 65535) {
        port = candidate;
      }
      continue;
    }
    if (wcscmp(argv[index], L"--port") == 0 && index + 1 < argc) {
      int candidate = _wtoi(argv[index + 1]);
      if (candidate >= 1 && candidate <= 65535) {
        port = candidate;
      }
    }
  }
  LocalFree(argv);
  return port;
}

static int has_command_line_arg(const wchar_t *expected) {
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return 0;
  int found = 0;
  for (int index = 1; index < argc; index++) {
    if (wcscmp(argv[index], expected) == 0) {
      found = 1;
      break;
    }
  }
  LocalFree(argv);
  return found;
}

static void open_main_ui(void) {
  DWORD now = GetTickCount();
  if (g_last_open_tick && now - g_last_open_tick < 1200) {
    return;
  }
  g_last_open_tick = now;

  wchar_t url[128];
  swprintf(url, 128, L"http://127.0.0.1:%d", g_port);
  ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
}

static int http_read_all(HINTERNET request, char *buffer, DWORD capacity) {
  DWORD total = 0;
  while (total + 1 < capacity) {
    DWORD read_bytes = 0;
    if (!InternetReadFile(request, buffer + total, capacity - total - 1, &read_bytes)) {
      return 0;
    }
    if (read_bytes == 0) {
      break;
    }
    total += read_bytes;
  }
  buffer[total] = '\0';
  return 1;
}

static void configure_http_timeouts(HINTERNET internet) {
  DWORD connect_timeout = HTTP_CONNECT_TIMEOUT_MS;
  DWORD send_timeout = HTTP_SEND_TIMEOUT_MS;
  DWORD receive_timeout = HTTP_RECEIVE_TIMEOUT_MS;
  InternetSetOptionW(internet, INTERNET_OPTION_CONNECT_TIMEOUT, &connect_timeout, sizeof(connect_timeout));
  InternetSetOptionW(internet, INTERNET_OPTION_SEND_TIMEOUT, &send_timeout, sizeof(send_timeout));
  InternetSetOptionW(internet, INTERNET_OPTION_RECEIVE_TIMEOUT, &receive_timeout, sizeof(receive_timeout));
}

static int http_get_path(const wchar_t *path, char *buffer, DWORD capacity) {
  HINTERNET internet = InternetOpenW(APP_NAME, INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
  if (!internet) {
    return 0;
  }
  configure_http_timeouts(internet);
  HINTERNET connect = InternetConnectW(internet, L"127.0.0.1", (INTERNET_PORT)g_port, NULL, NULL, INTERNET_SERVICE_HTTP, 0, 0);
  if (!connect) {
    InternetCloseHandle(internet);
    return 0;
  }
  HINTERNET request = HttpOpenRequestW(connect, L"GET", path, NULL, NULL, NULL, INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE, 0);
  if (!request) {
    InternetCloseHandle(connect);
    InternetCloseHandle(internet);
    return 0;
  }
  BOOL sent = HttpSendRequestW(request, NULL, 0, NULL, 0);
  int ok = sent && http_read_all(request, buffer, capacity);
  InternetCloseHandle(request);
  InternetCloseHandle(connect);
  InternetCloseHandle(internet);
  return ok;
}

static void http_post_shutdown(void) {
  HINTERNET internet = InternetOpenW(APP_NAME, INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
  if (!internet) {
    return;
  }
  configure_http_timeouts(internet);
  HINTERNET connect = InternetConnectW(internet, L"127.0.0.1", (INTERNET_PORT)g_port, NULL, NULL, INTERNET_SERVICE_HTTP, 0, 0);
  if (!connect) {
    InternetCloseHandle(internet);
    return;
  }
  HINTERNET request = HttpOpenRequestW(connect, L"POST", L"/api/system/shutdown", NULL, NULL, NULL, INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE, 0);
  if (request) {
    const char *body = "{}";
    HttpSendRequestW(request, L"Content-Type: application/json\r\n", (DWORD)-1, (LPVOID)body, 2);
    InternetCloseHandle(request);
  }
  InternetCloseHandle(connect);
  InternetCloseHandle(internet);
}

static int get_line_value(const char *response, const char *key, char *out, size_t out_size) {
  const char *cursor = response;
  size_t key_len = strlen(key);
  while (cursor && *cursor) {
    const char *line_end = strchr(cursor, '\n');
    size_t line_len = line_end ? (size_t)(line_end - cursor) : strlen(cursor);
    if (line_len >= key_len && strncmp(cursor, key, key_len) == 0) {
      size_t value_len = line_len - key_len;
      if (value_len >= out_size) {
        value_len = out_size - 1;
      }
      memcpy(out, cursor + key_len, value_len);
      out[value_len] = '\0';
      return 1;
    }
    cursor = line_end ? line_end + 1 : NULL;
  }
  return 0;
}

static int hex_value(char value) {
  if (value >= '0' && value <= '9') {
    return value - '0';
  }
  if (value >= 'a' && value <= 'f') {
    return value - 'a' + 10;
  }
  if (value >= 'A' && value <= 'F') {
    return value - 'A' + 10;
  }
  return -1;
}

static void percent_decode(char *value) {
  char *read_cursor = value;
  char *write_cursor = value;
  while (*read_cursor) {
    if (*read_cursor == '%' && hex_value(read_cursor[1]) >= 0 && hex_value(read_cursor[2]) >= 0) {
      *write_cursor++ = (char)((hex_value(read_cursor[1]) << 4) | hex_value(read_cursor[2]));
      read_cursor += 3;
      continue;
    }
    if (*read_cursor == '+') {
      *write_cursor++ = ' ';
      read_cursor++;
      continue;
    }
    *write_cursor++ = *read_cursor++;
  }
  *write_cursor = '\0';
}

static void utf8_to_wide(const char *input, wchar_t *output, int output_count) {
  if (!input || !*input) {
    output[0] = L'\0';
    return;
  }
  int written = MultiByteToWideChar(CP_UTF8, 0, input, -1, output, output_count);
  if (written <= 0) {
    output[0] = L'\0';
  } else {
    output[output_count - 1] = L'\0';
  }
}

static int read_encoded_value(const char *response, const char *key, wchar_t *output, int output_count) {
  char encoded[4096];
  if (!get_line_value(response, key, encoded, sizeof(encoded))) {
    return 0;
  }
  percent_decode(encoded);
  utf8_to_wide(encoded, output, output_count);
  return 1;
}

static LRESULT CALLBACK popup_window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_PAINT: {
      PAINTSTRUCT paint;
      HDC dc = BeginPaint(hwnd, &paint);
      RECT rect;
      GetClientRect(hwnd, &rect);

      HBRUSH background = CreateSolidBrush(RGB(24, 27, 31));
      FillRect(dc, &rect, background);
      DeleteObject(background);

      HBRUSH border = CreateSolidBrush(RGB(109, 222, 213));
      RECT top = rect;
      top.bottom = top.top + 3;
      FillRect(dc, &top, border);
      DeleteObject(border);

      SetBkMode(dc, TRANSPARENT);
      HFONT font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
      HFONT previous_font = (HFONT)SelectObject(dc, font);

      RECT text_rect = rect;
      text_rect.left += 16;
      text_rect.right -= 16;
      text_rect.top += 14;
      text_rect.bottom -= 12;

      SetTextColor(dc, RGB(234, 243, 240));
      RECT title_rect = text_rect;
      title_rect.bottom = title_rect.top + 24;
      DrawTextW(dc, g_notification_title, -1, &title_rect, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);

      SetTextColor(dc, RGB(190, 204, 202));
      RECT message_rect = text_rect;
      message_rect.top += 30;
      DrawTextW(dc, g_notification_message, -1, &message_rect, DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS);

      SelectObject(dc, previous_font);
      EndPaint(hwnd, &paint);
      return 0;
    }
    case WM_LBUTTONUP:
      ShowWindow(hwnd, SW_HIDE);
      return 0;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

static HWND ensure_popup_window(HWND *target, int kind) {
  if (*target) {
    return *target;
  }

  HWND window = CreateWindowExW(
    WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
    L"BiliRecord2KPopupWindow",
    APP_NAME,
    WS_POPUP,
    0,
    0,
    1,
    1,
    NULL,
    NULL,
    g_instance,
    NULL
  );
  if (window) {
    SetWindowLongPtrW(window, GWLP_USERDATA, kind);
    *target = window;
  }
  return window;
}

static void show_app_notification(const wchar_t *title, const wchar_t *message) {
  wcsncpy(g_notification_title, title, sizeof(g_notification_title) / sizeof(g_notification_title[0]) - 1);
  wcsncpy(g_notification_message, message, sizeof(g_notification_message) / sizeof(g_notification_message[0]) - 1);
  g_notification_title[sizeof(g_notification_title) / sizeof(g_notification_title[0]) - 1] = L'\0';
  g_notification_message[sizeof(g_notification_message) / sizeof(g_notification_message[0]) - 1] = L'\0';

  HWND popup = ensure_popup_window(&g_notification_popup, 2);
  if (!popup) {
    return;
  }

  POINT point;
  point.x = GetSystemMetrics(SM_CXSCREEN) - 24;
  point.y = GetSystemMetrics(SM_CYSCREEN) - 24;
  HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
  MONITORINFO info;
  ZeroMemory(&info, sizeof(info));
  info.cbSize = sizeof(info);
  GetMonitorInfoW(monitor, &info);

  int width = 380;
  int height = 118;
  int x = info.rcWork.right - width - 16;
  int y = info.rcWork.bottom - height - 16;
  SetWindowPos(popup, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  InvalidateRect(popup, NULL, TRUE);
  SetTimer(g_window, TIMER_NOTIFICATION, 8000, NULL);
}

static void update_tray_tip(const wchar_t *tip) {
  g_tray.uFlags = NIF_TIP | NIF_SHOWTIP;
  wcsncpy(g_tray.szTip, tip, sizeof(g_tray.szTip) / sizeof(g_tray.szTip[0]) - 1);
  g_tray.szTip[sizeof(g_tray.szTip) / sizeof(g_tray.szTip[0]) - 1] = L'\0';
  Shell_NotifyIconW(NIM_MODIFY, &g_tray);
}

static void show_tray_notification(const wchar_t *title, const wchar_t *message) {
  g_tray.uFlags = NIF_INFO;
  g_tray.dwInfoFlags = NIIF_INFO;
  wcsncpy(g_tray.szInfoTitle, title, sizeof(g_tray.szInfoTitle) / sizeof(g_tray.szInfoTitle[0]) - 1);
  wcsncpy(g_tray.szInfo, message, sizeof(g_tray.szInfo) / sizeof(g_tray.szInfo[0]) - 1);
  g_tray.szInfoTitle[sizeof(g_tray.szInfoTitle) / sizeof(g_tray.szInfoTitle[0]) - 1] = L'\0';
  g_tray.szInfo[sizeof(g_tray.szInfo) / sizeof(g_tray.szInfo[0]) - 1] = L'\0';
  if (!Shell_NotifyIconW(NIM_MODIFY, &g_tray)) {
    show_app_notification(title, message);
  }
}

static void apply_tray_state_response(const char *response) {
  wchar_t tooltip[128];
  if (read_encoded_value(response, "tooltip=", tooltip, 128)) {
    update_tray_tip(tooltip);
  }

  char seq_text[32];
  DWORD next_seq = g_last_notification_seq;
  if (get_line_value(response, "seq=", seq_text, sizeof(seq_text))) {
    next_seq = strtoul(seq_text, NULL, 10);
  }

  char notify_text[8];
  if (get_line_value(response, "notify=", notify_text, sizeof(notify_text)) && strcmp(notify_text, "1") == 0) {
    wchar_t title[128];
    wchar_t message[256];
    if (read_encoded_value(response, "title=", title, 128) && read_encoded_value(response, "message=", message, 256)) {
      show_tray_notification(title, message);
    }
  }

  g_last_notification_seq = next_seq;
}

static DWORD WINAPI tray_poll_thread(LPVOID parameter) {
  TrayPollRequest *request = (TrayPollRequest *)parameter;
  TrayPollResult *result = (TrayPollResult *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(TrayPollResult));
  if (result) {
    wchar_t path[128];
    swprintf(path, 128, L"/api/tray/state?after=%lu", request->after_seq);
    result->ok = http_get_path(path, result->response, sizeof(result->response));
    if (!PostMessageW(request->window, WM_TRAY_POLL_COMPLETE, 0, (LPARAM)result)) {
      HeapFree(GetProcessHeap(), 0, result);
      InterlockedExchange(&g_poll_in_progress, 0);
    }
  } else {
    InterlockedExchange(&g_poll_in_progress, 0);
  }
  HeapFree(GetProcessHeap(), 0, request);
  return 0;
}

static void start_tray_poll(HWND hwnd) {
  if (InterlockedCompareExchange(&g_poll_in_progress, 1, 0) != 0) {
    return;
  }
  TrayPollRequest *request = (TrayPollRequest *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(TrayPollRequest));
  if (!request) {
    InterlockedExchange(&g_poll_in_progress, 0);
    return;
  }
  request->window = hwnd;
  request->after_seq = g_last_notification_seq;
  HANDLE thread = CreateThread(NULL, 0, tray_poll_thread, request, 0, NULL);
  if (!thread) {
    HeapFree(GetProcessHeap(), 0, request);
    InterlockedExchange(&g_poll_in_progress, 0);
    return;
  }
  CloseHandle(thread);
}

static int get_tray_icon_anchor(HWND hwnd, POINT *point) {
  NOTIFYICONIDENTIFIER identifier;
  ZeroMemory(&identifier, sizeof(identifier));
  identifier.cbSize = sizeof(identifier);
  identifier.hWnd = hwnd;
  identifier.uID = TRAY_UID;
  RECT rect;
  if (SUCCEEDED(Shell_NotifyIconGetRect(&identifier, &rect))) {
    point->x = (rect.left + rect.right) / 2;
    point->y = (rect.top + rect.bottom) / 2;
    return 1;
  }
  return GetCursorPos(point);
}

static UINT tray_menu_alignment_flags(POINT point) {
  MONITORINFO info;
  ZeroMemory(&info, sizeof(info));
  info.cbSize = sizeof(info);
  HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
  if (!GetMonitorInfoW(monitor, &info)) {
    return TPM_LEFTALIGN | TPM_BOTTOMALIGN;
  }

  if (point.y >= info.rcWork.bottom) {
    return TPM_LEFTALIGN | TPM_BOTTOMALIGN;
  }
  if (point.y <= info.rcWork.top) {
    return TPM_LEFTALIGN | TPM_TOPALIGN;
  }
  if (point.x >= info.rcWork.right) {
    return TPM_RIGHTALIGN | TPM_TOPALIGN;
  }
  if (point.x <= info.rcWork.left) {
    return TPM_LEFTALIGN | TPM_TOPALIGN;
  }

  LONG distances[4] = {
    labs(point.x - info.rcWork.left),
    labs(point.x - info.rcWork.right),
    labs(point.y - info.rcWork.top),
    labs(point.y - info.rcWork.bottom)
  };
  int nearest = 0;
  for (int index = 1; index < 4; index++) {
    if (distances[index] < distances[nearest]) {
      nearest = index;
    }
  }
  if (nearest == 0) {
    return TPM_LEFTALIGN | TPM_TOPALIGN;
  }
  if (nearest == 1) {
    return TPM_RIGHTALIGN | TPM_TOPALIGN;
  }
  if (nearest == 2) {
    return TPM_LEFTALIGN | TPM_TOPALIGN;
  }
  return TPM_LEFTALIGN | TPM_BOTTOMALIGN;
}

static void show_tray_menu(HWND hwnd, POINT point) {

  HMENU menu = CreatePopupMenu();
  InsertMenuW(menu, 0, MF_BYPOSITION | MF_STRING, MENU_OPEN, L"打开主界面");
  InsertMenuW(menu, 1, MF_BYPOSITION | MF_SEPARATOR, 0, NULL);
  InsertMenuW(menu, 2, MF_BYPOSITION | MF_STRING, MENU_EXIT, L"退出程序");

  SetForegroundWindow(hwnd);
  TrackPopupMenu(menu, TPM_RIGHTBUTTON | tray_menu_alignment_flags(point), point.x, point.y, 0, hwnd, NULL);
  PostMessageW(hwnd, WM_NULL, 0, 0);
  DestroyMenu(menu);
}

static void remove_tray_icon(void) {
  if (g_tray.cbSize) {
    Shell_NotifyIconW(NIM_DELETE, &g_tray);
    ZeroMemory(&g_tray, sizeof(g_tray));
  }
}

static void exit_program(HWND hwnd) {
  KillTimer(hwnd, TIMER_POLL);
  http_post_shutdown();
  if (g_service_process) {
    WaitForSingleObject(g_service_process, 120000);
    CloseHandle(g_service_process);
    g_service_process = NULL;
  }
  remove_tray_icon();
  DestroyWindow(hwnd);
}

static void exit_tray_only(HWND hwnd) {
  KillTimer(hwnd, TIMER_POLL);
  if (g_service_process) {
    CloseHandle(g_service_process);
    g_service_process = NULL;
  }
  remove_tray_icon();
  DestroyWindow(hwnd);
}

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_TIMER:
      if (wparam == TIMER_POLL) {
        start_tray_poll(hwnd);
      } else if (wparam == TIMER_NOTIFICATION) {
        KillTimer(hwnd, TIMER_NOTIFICATION);
        if (g_notification_popup) {
          ShowWindow(g_notification_popup, SW_HIDE);
        }
      }
      return 0;
    case WM_TRAY_POLL_COMPLETE: {
      TrayPollResult *result = (TrayPollResult *)lparam;
      InterlockedExchange(&g_poll_in_progress, 0);
      if (result && result->ok) {
        apply_tray_state_response(result->response);
      } else {
        wchar_t tip[128];
        swprintf(tip, 128, L"哔哩录播 2K | 启动中 | 端口 %d", g_port);
        update_tray_tip(tip);
        if (g_service_process && WaitForSingleObject(g_service_process, 0) == WAIT_OBJECT_0) {
          if (result) {
            HeapFree(GetProcessHeap(), 0, result);
          }
          exit_tray_only(hwnd);
          return 0;
        }
      }
      if (result) {
        HeapFree(GetProcessHeap(), 0, result);
      }
      return 0;
    }
    case WM_COMMAND:
      switch (LOWORD(wparam)) {
        case MENU_OPEN:
          open_main_ui();
          return 0;
        case MENU_EXIT:
          exit_program(hwnd);
          return 0;
      }
      break;
    case WM_TRAYICON: {
      UINT tray_event = LOWORD(lparam);
      if (tray_event == NIN_SELECT || tray_event == NIN_KEYSELECT || tray_event == WM_LBUTTONUP || tray_event == WM_LBUTTONDBLCLK) {
        open_main_ui();
        return 0;
      }
      if (tray_event == WM_RBUTTONUP || tray_event == WM_CONTEXTMENU) {
        POINT point;
        if (tray_event == WM_CONTEXTMENU) {
          point.x = GET_X_LPARAM(wparam);
          point.y = GET_Y_LPARAM(wparam);
          if ((point.x == -1 && point.y == -1) || (point.x == 0 && point.y == 0)) {
            get_tray_icon_anchor(hwnd, &point);
          }
        } else if (!GetCursorPos(&point)) {
          get_tray_icon_anchor(hwnd, &point);
        }
        show_tray_menu(hwnd, point);
        return 0;
      }
      break;
    }
    case WM_DESTROY:
      remove_tray_icon();
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

static int add_tray_icon(HWND hwnd) {
  ZeroMemory(&g_tray, sizeof(g_tray));
  g_tray.cbSize = sizeof(g_tray);
  g_tray.hWnd = hwnd;
  g_tray.uID = TRAY_UID;
  g_tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  g_tray.uCallbackMessage = WM_TRAYICON;
  g_tray.hIcon = LoadIconW(g_instance, MAKEINTRESOURCEW(IDI_APP_ICON));
  if (!g_tray.hIcon) {
    g_tray.hIcon = LoadIconW(NULL, IDI_APPLICATION);
  }
  swprintf(g_tray.szTip, sizeof(g_tray.szTip) / sizeof(g_tray.szTip[0]), L"哔哩录播 2K | 启动中 | 端口 %d", g_port);
  if (!Shell_NotifyIconW(NIM_ADD, &g_tray)) {
    return 0;
  }
  g_tray.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &g_tray);
  return 1;
}

static int start_service(const wchar_t *app_dir) {
  wchar_t service_path[MAX_PATH];
  swprintf(service_path, MAX_PATH, L"%lsBiliRecord2K.Service.exe", app_dir);
  if (GetFileAttributesW(service_path) == INVALID_FILE_ATTRIBUTES) {
    show_error(L"找不到后台服务程序 BiliRecord2K.Service.exe。", GetLastError());
    return 0;
  }

  wchar_t service_command[COMMAND_CAPACITY];
  service_command[0] = L'\0';
  if (!append_quoted_arg(service_command, COMMAND_CAPACITY, service_path) ||
      !append_quoted_arg(service_command, COMMAND_CAPACITY, L"--prod")) {
    show_error(L"启动命令过长。", 0);
    return 0;
  }

  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argv) {
    for (int index = 1; index < argc; index++) {
      if (wcscmp(argv[index], L"--dev") == 0 || wcscmp(argv[index], L"--prod") == 0) {
        continue;
      }
      if (!append_quoted_arg(service_command, COMMAND_CAPACITY, argv[index])) {
        LocalFree(argv);
        show_error(L"启动命令过长。", 0);
        return 0;
      }
    }
    LocalFree(argv);
  }

  STARTUPINFOW startup_info;
  PROCESS_INFORMATION process_info;
  ZeroMemory(&startup_info, sizeof(startup_info));
  ZeroMemory(&process_info, sizeof(process_info));
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESHOWWINDOW;
  startup_info.wShowWindow = SW_HIDE;

  SetEnvironmentVariableW(L"BILI_RECORD_TRAY", L"1");
  BOOL created = CreateProcessW(
    NULL,
    service_command,
    NULL,
    NULL,
    FALSE,
    CREATE_NO_WINDOW | DETACHED_PROCESS,
    NULL,
    app_dir,
    &startup_info,
    &process_info
  );

  if (!created) {
    show_error(L"无法启动后台服务。", GetLastError());
    return 0;
  }

  CloseHandle(process_info.hThread);
  g_service_process = process_info.hProcess;
  return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
  (void)previous;
  (void)command;
  (void)show;
  g_instance = instance;
  g_port = resolve_port_from_args();

  if (has_command_line_arg(L"--request-shutdown")) {
    http_post_shutdown();
    for (int attempt = 0; attempt < 220; attempt++) {
      char response[256];
      Sleep(500);
      if (!http_get_path(L"/api/state", response, sizeof(response))) {
        return 0;
      }
    }
    return 2;
  }

  HANDLE mutex = CreateMutexW(NULL, TRUE, MUTEX_NAME);
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    open_main_ui();
    CloseHandle(mutex);
    return 0;
  }

  wchar_t launcher_path[MAX_PATH];
  DWORD path_length = GetModuleFileNameW(NULL, launcher_path, MAX_PATH);
  if (path_length == 0 || path_length >= MAX_PATH) {
    show_error(L"无法定位启动器路径。", GetLastError());
    return 1;
  }

  wchar_t app_dir[MAX_PATH];
  wcscpy(app_dir, launcher_path);
  wchar_t *slash = wcsrchr(app_dir, L'\\');
  if (!slash) {
    show_error(L"无法解析应用目录。", 0);
    return 1;
  }
  *(slash + 1) = L'\0';

  WNDCLASSW window_class;
  ZeroMemory(&window_class, sizeof(window_class));
  window_class.lpfnWndProc = window_proc;
  window_class.hInstance = instance;
  window_class.lpszClassName = L"BiliRecord2KTrayWindow";
  window_class.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APP_ICON));
  RegisterClassW(&window_class);

  WNDCLASSW popup_class;
  ZeroMemory(&popup_class, sizeof(popup_class));
  popup_class.lpfnWndProc = popup_window_proc;
  popup_class.hInstance = instance;
  popup_class.lpszClassName = L"BiliRecord2KPopupWindow";
  popup_class.hCursor = LoadCursorW(NULL, IDC_ARROW);
  RegisterClassW(&popup_class);

  g_window = CreateWindowExW(0, window_class.lpszClassName, APP_NAME, WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, instance, NULL);
  if (!g_window) {
    show_error(L"无法创建托盘窗口。", GetLastError());
    return 1;
  }

  if (!add_tray_icon(g_window)) {
    show_error(L"无法创建托盘图标。", GetLastError());
    return 1;
  }

  if (!start_service(app_dir)) {
    remove_tray_icon();
    return 1;
  }

  SetTimer(g_window, TIMER_POLL, 2000, NULL);
  start_tray_poll(g_window);

  MSG message;
  while (GetMessageW(&message, NULL, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (mutex) {
    CloseHandle(mutex);
  }
  return 0;
}
