#!/usr/bin/env python3
"""
Clear Stripe test data: subscriptions, customers, products, and prices.

Loads STRIPE_SECRET_KEY from environment or ../api/supabase/.env.

Usage:
  python scripts/clear-stripe.py              # interactive confirmation
  python scripts/clear-stripe.py --yes        # skip confirmation
  python scripts/clear-stripe.py --dry-run    # show what would be deleted
"""
import argparse
import os
import sys
from pathlib import Path

try:
    import stripe
except ImportError:
    sys.exit('stripe package not installed. run: pip install stripe')


ENV_FALLBACK_PATH = Path(__file__).resolve().parent.parent / 'api' / 'supabase' / '.env'


def load_env_file(path: Path) -> None:
    """Load environment variables from a .env file."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, val = line.split('=', 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def get_stripe_key() -> str:
    """Get Stripe secret key from environment."""
    key = os.environ.get('STRIPE_SECRET_KEY')
    if not key:
        load_env_file(ENV_FALLBACK_PATH)
        key = os.environ.get('STRIPE_SECRET_KEY')
    if not key:
        sys.exit('STRIPE_SECRET_KEY not found in environment or .env file')
    if not key.startswith('sk_test_'):
        sys.exit('refusing to run on non-test key (must start with sk_test_)')
    return key


def cancel_subscriptions(dry_run: bool = False) -> int:
    """Cancel all active subscriptions."""
    count = 0
    for sub in stripe.Subscription.list(limit=100, status='all').auto_paging_iter():
        if sub.status in ('active', 'trialing', 'past_due'):
            if dry_run:
                print(f'  would cancel subscription {sub.id}')
            else:
                stripe.Subscription.cancel(sub.id)
                print(f'  cancelled subscription {sub.id}')
            count += 1
    return count


def delete_customers(dry_run: bool = False) -> int:
    """Delete all customers."""
    count = 0
    for customer in stripe.Customer.list(limit=100).auto_paging_iter():
        if dry_run:
            print(f'  would delete customer {customer.id} ({customer.email})')
        else:
            stripe.Customer.delete(customer.id)
            print(f'  deleted customer {customer.id}')
        count += 1
    return count


def archive_prices(dry_run: bool = False) -> int:
    """Archive all prices (can't delete, only deactivate)."""
    count = 0
    for price in stripe.Price.list(limit=100, active=True).auto_paging_iter():
        if dry_run:
            print(f'  would archive price {price.id}')
        else:
            stripe.Price.modify(price.id, active=False)
            print(f'  archived price {price.id}')
        count += 1
    return count


def archive_products(dry_run: bool = False) -> int:
    """Archive all products (can't delete, only deactivate)."""
    count = 0
    for product in stripe.Product.list(limit=100, active=True).auto_paging_iter():
        if dry_run:
            print(f'  would archive product {product.id} ({product.name})')
        else:
            stripe.Product.modify(product.id, active=False)
            print(f'  archived product {product.id} ({product.name})')
        count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description='Clear Stripe test data')
    parser.add_argument('--yes', '-y', action='store_true', help='skip confirmation')
    parser.add_argument('--dry-run', action='store_true', help='show what would be deleted')
    args = parser.parse_args()
    # init stripe
    stripe.api_key = get_stripe_key()
    print(f'using stripe key: {stripe.api_key[:12]}...')
    # confirm
    if not args.yes and not args.dry_run:
        resp = input('this will delete all test subscriptions, customers, prices, and products. continue? [y/N] ')
        if resp.lower() != 'y':
            sys.exit('aborted')
    print()
    # cancel subscriptions first
    print('cancelling subscriptions...')
    sub_count = cancel_subscriptions(args.dry_run)
    print(f'  {sub_count} subscription(s) {"would be " if args.dry_run else ""}cancelled')
    # delete customers
    print('deleting customers...')
    cust_count = delete_customers(args.dry_run)
    print(f'  {cust_count} customer(s) {"would be " if args.dry_run else ""}deleted')
    # archive prices
    print('archiving prices...')
    price_count = archive_prices(args.dry_run)
    print(f'  {price_count} price(s) {"would be " if args.dry_run else ""}archived')
    # archive products
    print('archiving products...')
    prod_count = archive_products(args.dry_run)
    print(f'  {prod_count} product(s) {"would be " if args.dry_run else ""}archived')
    print()
    if args.dry_run:
        print('dry run complete. no changes made.')
    else:
        print('done! stripe test data cleared.')


if __name__ == '__main__':
    main()






