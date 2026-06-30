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
        subtitle={`${logs.length} 条记录`}
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
        <div className="log-list">
          {logs.length === 0 ? (
            <div className="empty-log">暂无日志</div>
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
