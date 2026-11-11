#!/usr/bin/env python3
"""
Create series.json files in Mylar format for folders that don't have them.
Searches Comic Vine and lets you pick the correct match.
"""

import os
import sys
import re
import json
import time
import requests
import yaml
from typing import Optional, List, Dict, Tuple
from html import unescape
from datetime import datetime, date, timedelta


class ComicVineSearcher:
    """Search Comic Vine for series matches"""
    
    BASE_URL = "https://comicvine.gamespot.com/api"
    
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "SeriesJsonCreator/1.0"
        self.last_request = 0
    
    def _request(self, endpoint: str, params: dict) -> Optional[dict]:
        # Rate limit: 1 request per second
        elapsed = time.time() - self.last_request
        if elapsed < 1.0:
            time.sleep(1.0 - elapsed)
        
        params["api_key"] = self.api_key
        params["format"] = "json"
        
        try:
            resp = self.session.get(f"{self.BASE_URL}/{endpoint}", params=params, timeout=30)
            self.last_request = time.time()
            
            if resp.status_code == 200:
                return resp.json()
            else:
                print(f"  API error: {resp.status_code}")
                return None
        except Exception as e:
            print(f"  Request error: {e}")
            return None
    
    def search_volumes(self, query: str, limit: int = 20) -> List[dict]:
        """Search for volumes matching the query"""
        data = self._request("search", {
            "query": query,
            "resources": "volume",
            "limit": limit,
            "field_list": "id,name,start_year,publisher,count_of_issues,image,description"
        })
        
        if not data or data.get("error") != "OK":
            return []
        
        results = []
        for item in data.get("results", []):
            results.append({
                "id": item.get("id"),
                "name": item.get("name"),
                "year": item.get("start_year"),
                "publisher": item.get("publisher", {}).get("name") if item.get("publisher") else "Unknown",
                "issue_count": item.get("count_of_issues", 0),
                "image": item.get("image", {}).get("medium_url") if item.get("image") else None,
                "description": self._clean_html(item.get("description", ""))[:200] if item.get("description") else ""
            })
        
        return results
    
    def get_volume_details(self, volume_id: int) -> Optional[dict]:
        """Get full details for a volume"""
        data = self._request(f"volume/4050-{volume_id}", {
            "field_list": "id,name,start_year,publisher,count_of_issues,image,description,first_issue,last_issue"
        })
        
        if not data or data.get("error") != "OK":
            return None
        
        result = data.get("results", {})
        
        # Get publication run from first/last issue
        pub_run = None
        first_issue = result.get("first_issue", {})
        last_issue = result.get("last_issue", {})
        if first_issue and last_issue:
            # Fetch issue dates
            first_date = self._get_issue_date(first_issue.get("id"))
            last_date = self._get_issue_date(last_issue.get("id"))
            if first_date and last_date:
                pub_run = f"{first_date} - {last_date}"
            elif first_date:
                pub_run = f"{first_date} - Present"
        
        return {
            "id": result.get("id"),
            "name": result.get("name"),
            "year": int(result.get("start_year")) if result.get("start_year") else None,
            "publisher": result.get("publisher", {}).get("name") if result.get("publisher") else "Unknown",
            "issue_count": result.get("count_of_issues", 0),
            "image": result.get("image", {}).get("medium_url") if result.get("image") else None,
            "description": self._clean_html(result.get("description", "")),
            "publication_run": pub_run
        }
    
    def _get_issue_date(self, issue_id: int) -> Optional[str]:
        """Get cover date for an issue"""
        if not issue_id:
            return None
        
        data = self._request(f"issue/4000-{issue_id}", {
            "field_list": "cover_date"
        })
        
        if not data or data.get("error") != "OK":
            return None
        
        cover_date = data.get("results", {}).get("cover_date")
        if cover_date:
            # Convert "1988-02-01" to "February 1988"
            try:
                from datetime import datetime
                dt = datetime.strptime(cover_date, "%Y-%m-%d")
                return dt.strftime("%B %Y")
            except:
                return cover_date
        return None
    
    def _clean_html(self, text: str) -> str:
        """Remove HTML tags and clean up text"""
        if not text:
            return ""
        # Remove HTML tags
        text = re.sub(r'<[^>]+>', '', text)
        # Decode HTML entities
        text = unescape(text)
        # Clean up whitespace
        text = re.sub(r'\s+', ' ', text).strip()
        return text


def extract_name_and_year(folder_name: str) -> Tuple[str, Optional[int]]:
    """Extract series name and year from folder name"""
    # Try patterns like "Series Name (2020)" or "Series Name (2020-2023)"
    match = re.match(r'^(.+?)\s*\((\d{4})(?:-\d{4})?\)$', folder_name)
    if match:
        return match.group(1).strip(), int(match.group(2))
    
    # Try pattern like "Series Name 2020-2023" at end
    match = re.match(r'^(.+?)\s+(\d{4})-\d{4}$', folder_name)
    if match:
        return match.group(1).strip(), int(match.group(2))
    
    return folder_name, None


def create_series_json(folder_path: str, volume: dict, publisher_override: str = None) -> dict:
    """Create a Mylar-style series.json structure"""
    
    # Determine status
    # Strategy: default Continuing, only mark Ended if the last issue date is
    # clearly in the past (> 3 months ago). A series with 1 issue or a recent
    # last issue date should never be assumed ended.
    status = "Continuing"
    pub_run = volume.get("publication_run", "") or ""
    if "Present" in pub_run:
        status = "Continuing"
    elif pub_run and " - " in pub_run:
        # Parse the end date from "Month YYYY - Month YYYY"
        end_part = pub_run.split(" - ")[-1].strip()
        try:
            end_date = datetime.strptime(end_part, "%B %Y").date()
            cutoff = date.today().replace(day=1) - timedelta(days=90)
            if end_date < cutoff:
                status = "Ended"
        except ValueError:
            # Unparseable end date — leave as Continuing to avoid false Ended
            status = "Continuing"
    
    series_json = {
        "version": "1.0.2",
        "metadata": {
            "type": "comicSeries",
            "publisher": publisher_override or volume.get("publisher", "Unknown"),
            "imprint": None,
            "name": volume.get("name"),
            "comicid": volume.get("id"),
            "year": volume.get("year"),
            "description_text": volume.get("description", ""),
            "description_formatted": volume.get("description", ""),
            "volume": volume.get("year"),  # Use year as volume identifier
            "booktype": "Print",
            "age_rating": None,
            "collects": None,
            "comic_image": volume.get("image"),
            "total_issues": volume.get("issue_count"),
            "publication_run": volume.get("publication_run"),
            "status": status
        }
    }
    
    return series_json


def find_folders_without_series_json(root_path: str, skip_patterns: List[str] = None) -> List[str]:
    """Find all folders that have comic files but no series.json"""
    skip_patterns = skip_patterns or []
    comic_extensions = {'.cbz', '.cbr', '.cb7', '.pdf'}
    folders = []
    
    for dirpath, dirnames, filenames in os.walk(root_path):
        # Skip certain folders
        if any(skip.lower() in dirpath.lower() for skip in skip_patterns):
            continue
        
        # Check if folder has comic files
        has_comics = any(
            os.path.splitext(f)[1].lower() in comic_extensions 
            for f in filenames
        )
        
        # Check if folder already has series.json
        has_series_json = "series.json" in filenames
        
        if has_comics and not has_series_json:
            folders.append(dirpath)
    
    return folders


def display_matches(matches: List[dict], folder_name: str):
    """Display search results for user to choose from"""
    print(f"\n{'='*60}")
    print(f"Folder: {folder_name}")
    print(f"{'='*60}")
    
    if not matches:
        print("  No matches found on Comic Vine")
        return
    
    for i, match in enumerate(matches, 1):
        year_str = f"({match['year']})" if match['year'] else "(No year)"
        pub_str = match['publisher'] or "Unknown"
        issues_str = f"{match['issue_count']} issues" if match['issue_count'] else "? issues"
        
        print(f"\n  [{i}] {match['name']} {year_str}")
        print(f"      Publisher: {pub_str} | {issues_str}")
        if match['description']:
            desc = match['description'][:100] + "..." if len(match['description']) > 100 else match['description']
            print(f"      {desc}")


def get_user_choice(num_matches: int) -> Optional[int]:
    """Get user's choice from matches"""
    print(f"\n  [S] Skip this folder")
    print(f"  [M] Manual search (enter custom query)")
    print(f"  [Q] Quit")
    
    while True:
        choice = input("\n  Enter choice: ").strip().upper()
        
        if choice == 'S':
            return None
        elif choice == 'M':
            return -1  # Signal for manual search
        elif choice == 'Q':
            return -2  # Signal to quit
        elif choice.isdigit():
            num = int(choice)
            if 1 <= num <= num_matches:
                return num
            else:
                print(f"  Please enter a number between 1 and {num_matches}")
        else:
            print("  Invalid choice")


def main():
    # Load config for API key
    config_path = os.path.join(os.path.dirname(__file__), "config.yaml")
    if not os.path.exists(config_path):
        print("Error: config.yaml not found")
        print("Please ensure config.yaml exists with your Comic Vine API key")
        sys.exit(1)
    
    with open(config_path, "r") as f:
        config = yaml.safe_load(f)
    
    cv_key = config.get("api_keys", {}).get("comicvine")
    if not cv_key:
        print("Error: Comic Vine API key not found in config.yaml")
        sys.exit(1)
    
    # Get path from command line
    if len(sys.argv) < 2:
        print("Usage: python create_series_json.py <path> [--dry-run]")
        print("\nScans for folders without series.json and helps create them")
        sys.exit(1)
    
    root_path = sys.argv[1]
    dry_run = "--dry-run" in sys.argv
    
    if not os.path.isdir(root_path):
        print(f"Error: {root_path} is not a directory")
        sys.exit(1)
    
    # Skip patterns from config
    skip_patterns = []
    for pub in config.get("publishers", {}).values():
        skip_patterns.extend(pub.get("skip_patterns", []))
    
    # Find folders without series.json
    print(f"Scanning {root_path} for folders without series.json...")
    folders = find_folders_without_series_json(root_path, skip_patterns)
    
    if not folders:
        print("All folders already have series.json files!")
        sys.exit(0)
    
    print(f"Found {len(folders)} folders without series.json\n")
    
    # Initialize Comic Vine client
    cv = ComicVineSearcher(cv_key)
    
    created = 0
    skipped = 0
    
    for folder_path in folders:
        folder_name = os.path.basename(folder_path)
        name, year = extract_name_and_year(folder_name)
        
        # Helper to compare years (handles string vs int)
        def year_matches(m_year, target_year):
            if m_year is None:
                return False
            if isinstance(m_year, str):
                m_year = int(m_year) if m_year.isdigit() else None
            return m_year == target_year
        
        # Search Comic Vine - try multiple queries to find best matches
        search_query = name
        matches = cv.search_volumes(search_query)
        
        # If year is known and no exact year match found, try searching with year
        if year and matches:
            has_year_match = any(year_matches(m.get('year'), year) for m in matches)
            if not has_year_match:
                # Try search with year included
                matches_with_year = cv.search_volumes(f"{name} {year}")
                if matches_with_year:
                    # Combine results, prioritizing year-specific search
                    seen_ids = {m['id'] for m in matches_with_year}
                    for m in matches:
                        if m['id'] not in seen_ids:
                            matches_with_year.append(m)
                    matches = matches_with_year
        
        # Also try with "The" prefix if not found
        if year and matches:
            has_year_match = any(year_matches(m.get('year'), year) for m in matches)
            if not has_year_match and not name.lower().startswith("the "):
                matches_with_the = cv.search_volumes(f"The {name}")
                if matches_with_the:
                    # Add any new matches
                    seen_ids = {m['id'] for m in matches}
                    for m in matches_with_the:
                        if m['id'] not in seen_ids:
                            matches.append(m)
        
        # Sort matches to prioritize matching year and DC/Marvel publishers
        if year and matches:
            def sort_key(m):
                m_year = m.get('year')
                # Convert to int if string
                if isinstance(m_year, str) and m_year.isdigit():
                    m_year = int(m_year)
                
                if m_year == year:
                    year_match = 0
                elif m_year and isinstance(m_year, int) and abs(m_year - year) <= 1:
                    year_match = 1
                else:
                    year_match = 2
                    
                # Prioritize DC/Marvel over foreign publishers
                pub = (m.get('publisher') or '').lower()
                pub_priority = 0 if pub in ('dc comics', 'marvel') else 1
                return (year_match, pub_priority, -m.get('issue_count', 0))
            matches.sort(key=sort_key)
        
        while True:
            display_matches(matches, folder_name)
            
            if not matches:
                choice = get_user_choice(0)
            else:
                choice = get_user_choice(len(matches))
            
            if choice == -2:  # Quit
                print(f"\nSummary: Created {created}, Skipped {skipped}")
                sys.exit(0)
            elif choice == -1:  # Manual search
                search_query = input("  Enter search query: ").strip()
                # Remove quotes if user added them
                search_query = search_query.strip('"\'')
                if search_query:
                    matches = cv.search_volumes(search_query, limit=20)
                continue
            elif choice is None:  # Skip
                skipped += 1
                break
            else:
                # User selected a match
                selected = matches[choice - 1]
                
                # Get full details
                print(f"\n  Fetching details for {selected['name']}...")
                volume = cv.get_volume_details(selected['id'])
                
                if not volume:
                    print("  Failed to get volume details, skipping")
                    skipped += 1
                    break
                
                # Detect publisher from path if possible
                publisher = None
                path_lower = folder_path.lower()
                if "dc comics" in path_lower or "dc universe" in path_lower:
                    publisher = "DC Comics"
                elif "marvel" in path_lower:
                    publisher = "Marvel"
                
                # Create series.json
                series_json = create_series_json(folder_path, volume, publisher)
                output_path = os.path.join(folder_path, "series.json")
                
                # Show what will be created
                print(f"\n  Will create: {output_path}")
                print(f"    Name: {series_json['metadata']['name']}")
                print(f"    Year: {series_json['metadata']['year']}")
                print(f"    Publisher: {series_json['metadata']['publisher']}")
                print(f"    Issues: {series_json['metadata']['total_issues']}")
                print(f"    Comic Vine ID: {series_json['metadata']['comicid']}")
                
                if dry_run:
                    print(f"\n  [DRY RUN] Would create this file")
                    created += 1
                else:
                    # Confirm creation
                    confirm = input("\n  Create this series.json? [Y/n]: ").strip().lower()
                    if confirm in ('', 'y', 'yes'):
                        with open(output_path, "w", encoding="utf-8") as f:
                            json.dump(series_json, f, indent=4)
                        print(f"  ✓ Created successfully")
                        created += 1
                    else:
                        print("  Skipped")
                        skipped += 1
                
                break
    
    print(f"\n{'='*60}")
    print(f"Summary: Created {created}, Skipped {skipped}")
    print(f"{'='*60}")
    
    if created > 0:
        print("\nYou can now run the enricher to add metadata:")
        print(f"  python enricher.py enrich \"{root_path}\" --recursive")


if __name__ == "__main__":
    main()
