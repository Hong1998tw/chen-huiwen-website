"""Reviewed deployment routing. No URLs, workflow names or credentials are configurable."""
import json
from pathlib import Path

PAGES_PROVIDER = 'github-pages'
CLOUDFLARE_PROVIDER = 'cloudflare-static-assets'
TARGET_FILE = 'data/deployment-target.json'
REQUEST_FILE = 'data/deployment-request.json'
DEPLOYMENT_WORKFLOWS = {
    PAGES_PROVIDER: ('pages.yml', 'github-pages'),
    CLOUDFLARE_PROVIDER: ('cloudflare-public.yml', 'cloudflare-public-delivery'),
}


def provider(root):
    """Absent config means legacy Pages; malformed or unsupported config fails closed."""
    path = Path(root) / TARGET_FILE
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return PAGES_PROVIDER
    value = json.loads(text)
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'provider'} \
            or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 \
            or not isinstance(value['provider'], str) or value['provider'] not in DEPLOYMENT_WORKFLOWS:
        raise ValueError('Unsupported deployment target configuration')
    return value['provider']
