"""add created_at to User

Revision ID: 3c1f9a7e2d40
Revises: b6bedeed9aa3
Create Date: 2026-11-14 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3c1f9a7e2d40'
down_revision: Union[str, Sequence[str], None] = 'b6bedeed9aa3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 기존 행에는 실제 가입 시각 대신 마이그레이션 실행 시각이 들어간다
    op.add_column(
        'User',
        sa.Column(
            'created_at',
            sa.DateTime(),
            server_default=sa.text('CURRENT_TIMESTAMP'),
            nullable=False,
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('User', 'created_at')
