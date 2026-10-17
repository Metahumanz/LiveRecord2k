"""Exercise the actual helper verifier without requiring GI or Jetson hardware."""
import ast, hashlib, io, pathlib, types, sys, os

helper = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(os.environ['BR2K_JETSON_NVMM_HELPER']) if os.environ.get('BR2K_JETSON_NVMM_HELPER') else pathlib.Path(__file__).resolve().parents[1] / 'assets/scene-renderer/jetson/br2k-scene-gpu.py'
tree = ast.parse(helper.read_text(encoding='utf-8'))
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'verify_native_output_storage')
data = b'a' * (5 * 1024 * 1024)
clock = [0]
reports = []
syncs = []

class File(io.BytesIO):
    def fileno(self): return 7
    def read(self, size=-1):
        clock[0] += 0.3
        return super().read(size)

def fail(message): raise ValueError(message)

scope = {'hashlib': hashlib, 'open': lambda *args: File(data),
         'os': types.SimpleNamespace(fsync=lambda fd: syncs.append(fd)),
         'time': types.SimpleNamespace(monotonic=lambda: clock[0]), 'fail': fail}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(helper), 'exec'), scope)
verify = scope['verify_native_output_storage']
verify('output.mkv', len(data), hashlib.sha256(data).digest(), reports.append)
assert syncs == [7]
assert reports[0]['phase'] == 'sync'
assert reports[-1]['complete'] and reports[-1]['verifiedBytes'] == len(data)
reads = [r['verifiedBytes'] for r in reports if r['phase'] == 'storage' and not r.get('complete')]
assert reads == [0, 1024**2, 2*1024**2, 3*1024**2, 4*1024**2, 5*1024**2], reads
for size, digest in [(len(data)+1, hashlib.sha256(data).digest()), (len(data), b'wrong digest')]:
    reports.clear()
    try: verify('output.mkv', size, digest, reports.append)
    except ValueError: pass
    else: raise AssertionError('corrupt output passed verification')
    assert not any(r.get('complete') for r in reports)
reports.clear()
def blocked_open(*args): raise OSError('storage unavailable')
scope['open'] = blocked_open
try: verify('output.mkv', len(data), hashlib.sha256(data).digest(), reports.append)
except OSError: pass
else: raise AssertionError('storage failure was suppressed')
assert len(reports) == 1, 'a blocked read must not emit artificial progress'
print('storage verification: progress, digest, length and blocked I/O passed')
