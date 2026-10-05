import os
import plistlib
from pathlib import Path

def render(project, node, data, groups, operators='', source=None):
    project, node, data = [str(Path(p).resolve()) for p in (project, node, data)]
    return {
        'Label': 'com.aurea.wpp-vip-ingest',
        'ProgramArguments': [node, str(Path(project) / 'src/cli.mjs'), 'worker'],
        'WorkingDirectory': project,
        'EnvironmentVariables': {
            'WPP_DATA_DIR': data, 'WPP_GROUPS': groups, 'WPP_OPERATORS': operators,
            'WPP_SOURCE': str(Path(source).resolve()) if source else str(Path(data) / 'source.json'),
            'PATH': f'{Path(node).parent}:/usr/bin:/bin:/usr/sbin:/sbin',
        },
        'RunAtLoad': True,
        'KeepAlive': {'SuccessfulExit': False},
        'ThrottleInterval': 60,
        'StandardOutPath': str(Path(data) / 'worker.stdout.log'),
        'StandardErrorPath': str(Path(data) / 'worker.stderr.log'),
    }

if __name__ == '__main__':
    payload = render(os.environ['WPP_PROJECT_PATH'], os.environ['WPP_NODE_PATH'],
                     os.environ['WPP_DATA_DIR'], os.environ['WPP_GROUPS'],
                     os.environ.get('WPP_OPERATORS', ''), os.environ.get('WPP_SOURCE'))
    target = Path.home() / 'Library/LaunchAgents/com.aurea.wpp-vip-ingest.plist'
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('wb') as output:
        plistlib.dump(payload, output)
