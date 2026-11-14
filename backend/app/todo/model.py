from dataclasses import dataclass
from datetime import date, datetime


@dataclass
class Todo:
    id: int
    user_id: int
    title: str
    created_time: datetime
    edited_time: datetime
    description: str | None = None
    is_completed: bool = False
    due_date: date | None = None
    completed_time: datetime | None = None
