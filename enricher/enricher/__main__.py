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
@click.option(
    "--incomplete",
    is_flag=True,
    help="Re-process enriched events still missing any enrichable field "
    "(price_to alone is ignored when price_from is set)",
)
def run(limit, dry_run, resume, force, incomplete):
    """Run the enrichment pipeline."""
    if force and incomplete:
        raise click.UsageError("--force and --incomplete are mutually exclusive")
    config = load_config()
    click.echo(f"Enricher ready. Ollama: {config.ollama_url}, SearXNG: {config.searxng_url}")
    if dry_run:
        click.echo("=== DRY RUN ===")
    asyncio.run(run_pipeline(config, limit, dry_run, resume, force, incomplete))


@cli.command()
@click.option("--since", type=str, default=None, help="Sync events enriched since date (YYYY-MM-DD), e.g. 'today', 'yesterday', '2026-04-04'")
@click.option("--dry-run", is_flag=True, help="Show changes without writing to DB")
def sync(since, dry_run):
    """Push enriched scraper_all fields to calendar_events."""
    config = load_config()
    if dry_run:
        click.echo("=== DRY RUN ===")
    sync_to_calendar(config, since, dry_run)


@cli.command()
@click.option("--limit", type=int, default=None, help="Max events to audit")
@click.option("--fields", type=str, default="website",
              help="Comma-separated URL fields to audit (website, registration_url, regulamin_url)")
@click.option("--since", type=str, default="today",
              help="Lower bound on event date (YYYY-MM-DD | 'today' | 'tomorrow')")
@click.option("--confidence-threshold", type=float, default=0.8,
              help="Fast-path confidence below this triggers fallback to full crawl")
@click.option("--resume", is_flag=True,
              help="Continue the most recent audit log: skip already-processed (event, field) pairs and append to the same file")
@click.option("--apply", is_flag=True,
              help="Null mismatched and uncertain URL fields on calendar_events AND scraper_all")
@click.option("--apply-confidence", type=float, default=0.8,
              help="Minimum confidence to null a mismatched field when --apply is set")
@click.option("--keep-uncertain", is_flag=True,
              help="Keep uncertain verdicts instead of nulling them (default: uncertain is nulled with --apply)")
def audit(limit, fields, since, confidence_threshold, resume, apply, apply_confidence, keep_uncertain):
    """Audit URL fields on calendar_events for event relevance.

    By default read-only — writes JSONL report. Pass --apply to also null
    mismatched fields on calendar_events.
    """
    from enricher.audit import run_audit, _parse_since

    config = load_config()
    field_list = [f.strip() for f in fields.split(",") if f.strip()]
    allowed = {"website", "registration_url", "regulamin_url"}
    bad = [f for f in field_list if f not in allowed]
    if bad:
        raise click.UsageError(f"--fields may only contain {sorted(allowed)}, got unknown: {bad}")
    since_date = _parse_since(since)
    click.echo(f"Audit ready. Ollama: {config.ollama_url}")
    asyncio.run(run_audit(
        config=config,
        since=since_date,
        fields=field_list,
        limit=limit,
        confidence_threshold=confidence_threshold,
        resume=resume,
        apply=apply,
        apply_confidence=apply_confidence,
        keep_uncertain=keep_uncertain,
    ))


if __name__ == "__main__":
    cli()
