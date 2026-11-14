from dataclasses import dataclass, field
from datetime import datetime


@dataclass(kw_only=True)
class User:
    id: int | None = None  # DB AUTO_INCREMENT. 저장 전에는 None
    name: str
    email: str
    password: str = field(repr=False)
    created_at: datetime | None = None  # DB가 기록(UTC). 저장 전에는 None
