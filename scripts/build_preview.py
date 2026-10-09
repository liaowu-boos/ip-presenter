"""Build one self-contained file with no CDN or npm dependency.
The source remains modular ES modules. Order is explicit and checked in tests.
"""
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
front=root/'frontend'
files=['core.js','demo.js','demo-avatar.js','avatar.js','pcm-playback-clock.js','audio.js','stage.js','storage.js','lecture-plan.js','runtime.js','voice-input.js','voice-dialogue.js','voice-session.js','manual-listening.js','qwen-session.js','app.js']
chunks=[]
for name in files:
    src=(front/'src'/name).read_text()
    src=re.sub(r'^import .*?;\s*$', '', src, flags=re.M)
    src=re.sub(r'^export ', '', src, flags=re.M)
    chunks.append('// '+name+'\n'+src)
js='(()=>{\n'+ '\n'.join(chunks)+'\n})();'
html=(front/'index.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="style.css(?:\?[^\"]*)?">',lambda _: '<style>'+ (front/'style.css').read_text()+'</style>',html)
html=re.sub(r'<script type="module" src="src/app.js(?:\?[^\"]*)?"></script>',lambda _: '<script>'+js.replace('</script','<\\/script')+'</script>',html)
(root/'直接预览.html').write_text(html)
print(f'Built 直接预览.html: {len(html.encode()):,} bytes')
