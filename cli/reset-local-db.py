#!/usr/bin/env python3
"""
Reset the local Supabase database by running `supabase db reset`.

This drops all tables and re-runs all migrations from scratch.

Usage:
  python scripts/reset-local-db.py          # interactive confirmation
  python scripts/reset-local-db.py --yes    # skip confirmation
"""
import argparse
import subprocess
import sys
from pathlib import Path


SUPABASE_DIR = Path(__file__).resolve().parent.parent / 'api' / 'supabase'


def run_command(cmd: list[str], cwd: Path) -> bool:
    """Run a command and return True if successful."""
    print(f'running: {" ".join(cmd)}')
    print()
    result = subprocess.run(cmd, cwd=cwd)
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(description='Reset local Supabase database')
    parser.add_argument('--yes', '-y', action='store_true', help='skip confirmation')
    args = parser.parse_args()
    # check supabase dir exists
    if not SUPABASE_DIR.exists():
        sys.exit(f'supabase directory not found: {SUPABASE_DIR}')
    # confirm
    if not args.yes:
        print('this will DROP all tables and re-run migrations on the local database.')
        print(f'working directory: {SUPABASE_DIR}')
        print()
        resp = input('continue? [y/N] ')
        if resp.lower() != 'y':
            sys.exit('aborted')
        print()
    # run db reset
    success = run_command(['supabase', 'db', 'reset'], cwd=SUPABASE_DIR)
    if success:
        print()
        print('local database reset complete.')
        print('note: you may need to restart supabase functions serve')
    else:
        sys.exit('db reset failed')


if __name__ == '__main__':
    main()






