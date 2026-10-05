"""Copy the reviewed public card renderer and assets into the authenticated CMS bundle."""
from python_guard import require_supported_python
require_supported_python()
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parents[1]
FILES=['legal-calendar.js','legal-calendar.css']+['assets/legal/'+n for n in ('portrait.webp','brand-reference.webp','card-serif.woff','card-sans.woff','OFL.txt')]
def build(root=ROOT):
    for relative in FILES:
        source=root/relative
        destination=root/'admin/public'/relative
        destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,destination)
if __name__=='__main__':build()
