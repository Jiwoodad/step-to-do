from collections.abc import Callable
from typing import Annotated

from fastapi import HTTPException, Depends
from app.user.domain.model import User
from app.user.domain.repository.user_repo import IUserRepository


class UserService:
    def __init__(
        self,
        hash_password: Callable[[str], str],
        user_repo: IUserRepository,
    ) -> None:
        self.user_repo = user_repo
        self.hash_password = hash_password

    def create_user(self, email: str, password: str) -> User:
        self.user_repo.validate_email_format(email)

        _user = None
        try:
            _user = self.user_repo.find_by_email(email)
        except HTTPException as e:
            if e.status_code != 422:
                raise e
        if _user:
            raise HTTPException(status_code=422)

        password_hash = self.hash_password(password)
        user = User(email=email, password=password_hash)
        self.user_repo.save(user)
        return user
