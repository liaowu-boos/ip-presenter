"""Conservative public-tree checks; never print a credential's value.

Scans the current distributable tree, including tracked ignored paths when Git
is available. It does not scan Git history or guarantee absence of secrets.
"""
from pathlib import Path
import re
import base64
import hashlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.runtime', '.backups',
        'assets', 'outputs', 'dist', 'releases', 'visual-review', 'projects', 'htmlcov'}
PATTERNS = {
    'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'provider token': re.compile(r'\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b'),
    'personal home path': re.compile(r'(?:/Users/|/home/)[A-Za-z][A-Za-z0-9_.-]+/'),
    'private design link': re.compile(r'https://(?:www\.)?figma\.com/(?:design|file)/[A-Za-z0-9]{10,}'),
}
# Exact hashes of the newly drawn generic robot; no original artwork allowed.
PUBLIC_DEMO_IMAGES = {
    'b995833a3c216a66bf19d8c4048652dcc8fd5427a43aa867ccbd8d44b4f645e5',
    'fce093c7ae892ee1913c1ee7ce0e0293b5e5b1f4656a156b00ef612e75000cf4',
}
EMBEDDED_MEDIA = re.compile(r'data:(?:image|audio|video)/[^,\s"\']+,([A-Za-z0-9+/=]{64,})')
BINARY = {'.mp4', '.webm', '.mov', '.wav', '.mp3', '.onnx', '.pt', '.pth', '.safetensors', '.ses', '.pem', '.key'}


def main():
    files = set()
    # Prune large local directories without opening files inside them.
    def visit(directory):
        for path in directory.iterdir():
            if path.name.startswith('.env') and path.name != '.env.example': continue
            if path.name == '直接预览.html' or path.name.endswith('.ip-presenter.json'): continue
            if path.name in SKIP: continue
            if path.is_symlink(): files.add(path)
            elif path.is_dir(): visit(path)
            elif path.is_file(): files.add(path)
    visit(ROOT)
    tracked = set()
    git_root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=ROOT, capture_output=True, text=True)
    if git_root.returncode == 0 and Path(git_root.stdout.strip()).resolve() == ROOT:
        result = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True)
        tracked = {ROOT/p.decode() for p in result.stdout.split(b'\0') if p}
        files.update(tracked)
    issues = []
    for path in sorted(files):
        rel = path.relative_to(ROOT)
        if path in tracked and (any(part in SKIP - {'.git'} for part in rel.parts) or
                                path.name.startswith('.env') and path.name != '.env.example' or
                                path.name == '直接预览.html' or path.name.endswith('.ip-presenter.json')):
            issues.append((rel, 'tracked local/private/generated path'))
        if path.is_symlink():
            issues.append((rel, 'symlink')); continue
        if not path.exists():
            issues.append((rel, 'tracked file missing from worktree')); continue
        if path.stat().st_size > 2 * 1024 * 1024:
            issues.append((rel, 'file exceeds source-only 2 MiB budget')); continue
        if path.suffix.lower() in BINARY:
            issues.append((rel, 'unexpected media/model/credential file')); continue
        try: content = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            issues.append((rel, 'unexpected binary file')); continue
        for payload in EMBEDDED_MEDIA.findall(content):
            try:
                digest = hashlib.sha256(base64.b64decode(payload, validate=True)).hexdigest()
            except ValueError:
                digest = None
            if rel.as_posix() != 'frontend/src/demo-avatar.js' or digest not in PUBLIC_DEMO_IMAGES:
                issues.append((rel, 'unapproved embedded media'))
        for label, pattern in PATTERNS.items():
            if pattern.search(content): issues.append((rel, label))
    for rel, reason in issues:
        print(f'FAIL {rel}: {reason}')
    print(f'Checked {len(files)} public files; {len(issues)} issue(s). No secret values printed.')
    return bool(issues)


if __name__ == '__main__':
    sys.exit(main())
