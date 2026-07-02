import { recorder } from '../recorderClient';
import { LogRow, PageHeader } from '../components/common';
import type { LogEntry } from '../types';

export function LogsPage({
  logs,
  busy,
  run
}: {
  logs: LogEntry[];
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  return (
    <>
      <PageHeader
        title="日志"
        subtitle="登录、刷新、录制、生成弹幕视频和更新失败时，可以先来这里看原因。"
        actions={
          <button
            className="wide-button"
            disabled={busy === 'clear-logs'}
            onClick={() => run('clear-logs', recorder.clearLogs)}
          >
            清空
          </button>
        }
      />
      <section className="log-panel full-log-panel">
        <p className="log-summary">当前保留 {logs.length} 条运行日志。</p>
        <div className="log-list">
          {logs.length === 0 ? (
            <div className="empty-log">还没有日志。开始登录、添加直播间或录制后，运行信息会显示在这里。</div>
          ) : (
            logs
              .slice()
              .reverse()
              .map((entry) => <LogRow key={entry.id} entry={entry} />)
          )}
        </div>
      </section>
    </>
  );
}
