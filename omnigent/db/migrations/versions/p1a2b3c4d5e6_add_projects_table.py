"""add projects table

Revision ID: p1a2b3c4d5e6
Revises: n1a2b3c4d5e6
Create Date: 2026-07-01 00:00:00.000000

Adds the ``projects`` table holding per-project metadata keyed by project
name (the same string stored in the ``omni_project`` conversation label):

- ``name``: String PK — the project name / join key to membership labels.
- ``description``: nullable Text — standing instructions injected as a
  ``<project_instructions>`` block into member sessions' system prompt
  (the "functional projects" feature). ``Text`` so it can exceed the
  256-char cap on ``conversation_labels.value``.
- ``icon``: nullable String — optional icon id for the projects UI.
- ``created_at`` / ``updated_at``: Unix epoch seconds.

Purely additive: membership is unchanged (still the ``omni_project`` label
on each session). A project can be label-only (no row here) or a row here
with zero member sessions; ``list_projects_detailed`` unions both. Portable
DDL — ``create_table`` / ``drop_table`` only, no SQLite-specific syntax, so
it applies cleanly on both SQLite and PostgreSQL.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "p1a2b3c4d5e6"
down_revision: str | None = "n1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("icon", sa.String(length=256), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("name"),
    )


def downgrade() -> None:
    op.drop_table("projects")
