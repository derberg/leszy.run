import click
from enricher.config import load_config


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
    click.echo("Pipeline not yet implemented.")


if __name__ == "__main__":
    cli()
