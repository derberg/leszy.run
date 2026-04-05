import asyncio
import click
from enricher.config import load_config
from enricher.pipeline import run_pipeline
from enricher.sync import sync_to_calendar


@click.group()
def cli():
    """LeszyRun event enricher — local LLM pipeline."""
    pass


@cli.command()
@click.option("--limit", type=int, default=None, help="Max events to process")
@click.option("--dry-run", is_flag=True, help="Show changes without writing to DB")
@click.option("--resume", is_flag=True, help="Skip events from most recent run log")
@click.option("--force", is_flag=True, help="Re-process even if enriched_at is set")
def run(limit, dry_run, resume, force):
    """Run the enrichment pipeline."""
    config = load_config()
    click.echo(f"Enricher ready. Ollama: {config.ollama_url}, SearXNG: {config.searxng_url}")
    if dry_run:
        click.echo("=== DRY RUN ===")
    asyncio.run(run_pipeline(config, limit, dry_run, resume, force))


@cli.command()
@click.option("--since", type=str, default=None, help="Sync events enriched since date (YYYY-MM-DD), e.g. 'today', 'yesterday', '2026-04-04'")
@click.option("--dry-run", is_flag=True, help="Show changes without writing to DB")
def sync(since, dry_run):
    """Push enriched scraper_all fields to calendar_events."""
    config = load_config()
    if dry_run:
        click.echo("=== DRY RUN ===")
    sync_to_calendar(config, since, dry_run)


if __name__ == "__main__":
    cli()
