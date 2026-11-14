from dataclasses import dataclass, field


@dataclass
class User:
    email: str
    password: str = field(repr=False)
    id: int | None = None  # DB AUTO_INCREMENT. 저장 전에는 None
