"""add name to User

Revision ID: 8d2e4b6a9f15
Revises: 3c1f9a7e2d40
Create Date: 2026-11-14 13:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8d2e4b6a9f15'
down_revision: Union[str, Sequence[str], None] = '3c1f9a7e2d40'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 기존 행을 채우려고 임시 기본값 ''을 둔 뒤, 기본값을 지운다(새 행은 앱이 name을 반드시 넣는다).
    # 기존 테스트 계정의 name은 빈 문자열로 남으니 필요하면 직접 UPDATE한다.
    op.add_column(
        'User',
        sa.Column('name', sa.String(length=20), server_default='', nullable=False),
    )
    op.alter_column(
        'User',
        'name',
        existing_type=sa.String(length=20),
        existing_nullable=False,
        server_default=None,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('User', 'name')
