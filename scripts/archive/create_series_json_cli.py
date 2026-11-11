#!/usr/bin/env python3
"""
CLI wrapper: create_series_json_cli.py <folder_path> <cv_volume_id> [--config config.yaml]
Fetches volume details from Comic Vine and writes series.json to folder_path.
Prints JSON result to stdout.
"""

import os, sys, json, yaml, re, time, requests
from html import unescape
from datetime import datetime

def load_config(config_path):
    with open(config_path) as f:
        return yaml.safe_load(f)

def clean_html(text):
    if not text: return ''
    text = re.sub(r'<[^>]+>', '', text)
    text = unescape(text)
    return re.sub(r'\s+', ' ', text).strip()

class CV:
    BASE = 'https://comicvine.gamespot.com/api'
    def __init__(self, api_key):
        self.key = api_key
        self.last = 0
    def get(self, endpoint, params={}):
        elapsed = time.time() - self.last
        if elapsed < 1.1: time.sleep(1.1 - elapsed)
        params = {**params, 'api_key': self.key, 'format': 'json'}
        r = requests.get(f'{self.BASE}/{endpoint}', params=params,
                         headers={'User-Agent': 'Omnibus/1.0'}, timeout=30)
        self.last = time.time()
        if r.status_code == 200: return r.json()
        return None

    def issue_date(self, issue_id):
        if not issue_id: return None
        d = self.get(f'issue/4000-{issue_id}', {'field_list': 'cover_date'})
        cd = d and d.get('results', {}).get('cover_date')
        if cd:
            try: return datetime.strptime(cd, '%Y-%m-%d').strftime('%B %Y')
            except: return cd
        return None

    def volume(self, cv_id):
        d = self.get(f'volume/4050-{cv_id}', {
            'field_list': 'id,name,start_year,publisher,count_of_issues,image,description,first_issue,last_issue'
        })
        if not d or d.get('error') != 'OK': return None
        r = d['results']

        # Build publication run from issue dates
        pub_run = None
        fi = r.get('first_issue', {})
        li = r.get('last_issue', {})
        if fi:
            fd = self.issue_date(fi.get('id'))
            ld = self.issue_date(li.get('id')) if li else None
            if fd and ld and fd != ld:
                pub_run = f'{fd} - {ld}'
            elif fd:
                pub_run = f'{fd} - Present'

        return {
            'id':              r.get('id'),
            'name':            r.get('name'),
            'year':            int(r['start_year']) if r.get('start_year') else None,
            'publisher':       (r.get('publisher') or {}).get('name', 'Unknown'),
            'issue_count':     r.get('count_of_issues', 0),
            'image':           (r.get('image') or {}).get('medium_url'),
            'description':     clean_html(r.get('description', '')),
            'publication_run': pub_run,
        }

def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(json.dumps({'error': 'Usage: create_series_json_cli.py <folder_path> <cv_id> [--config path]'}))
        sys.exit(1)

    folder_path = args[0]
    cv_id       = int(args[1])
    config_path = None
    for i, a in enumerate(args):
        if a == '--config' and i+1 < len(args):
            config_path = args[i+1]

    if not config_path:
        config_path = os.path.join(os.path.dirname(__file__), 'config.yaml')

    try:
        cfg = load_config(config_path)
        api_key = cfg.get('api_keys', {}).get('comicvine') or cfg.get('comicvine', {}).get('api_key') or cfg.get('cv_api_key', '')
    except Exception as e:
        print(json.dumps({'error': f'Config error: {e}'})); sys.exit(1)

    cv = CV(api_key)
    print(f'[create] Fetching CV volume {cv_id}...', file=sys.stderr)
    vol = cv.volume(cv_id)
    if not vol:
        print(json.dumps({'error': f'Could not fetch CV volume {cv_id}'})); sys.exit(1)

    status = 'Continuing' if vol.get('publication_run') and 'Present' in vol['publication_run'] else 'Ended'

    content = {
        'version': '1.0.2',
        'metadata': {
            'type':                  'comicSeries',
            'publisher':             vol['publisher'],
            'imprint':               None,
            'name':                  vol['name'],
            'comicid':               vol['id'],
            'year':                  vol['year'],
            'description_text':      vol['description'],
            'description_formatted': vol['description'],
            'volume':                vol['year'],
            'booktype':              'Print',
            'age_rating':            None,
            'collects':              None,
            'comic_image':           vol['image'],
            'total_issues':          vol['issue_count'],
            'publication_run':       vol['publication_run'],
            'status':                status,
            'characters':            [],
            'genres':                [],
        }
    }

    os.makedirs(folder_path, exist_ok=True)
    out = os.path.join(folder_path, 'series.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(content, f, indent=2, ensure_ascii=False)

    print(json.dumps({'success': True, 'path': out, 'name': vol['name'], 'comicid': vol['id']}))

if __name__ == '__main__':
    main()
