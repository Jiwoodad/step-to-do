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

    def create_user(self, email: str, password: str, name: str) -> User:
        _user = None
        try:
            _user = self.user_repo.find_by_email(email)
        except HTTPException as e:
            if e.status_code != 422:
                raise e
        if _user:
            raise HTTPException(status_code=422)

        password_hash = self.hash_password(password)
        user = User(email=email, password=password_hash, name=name)
        self.user_repo.save(user)
        return user

    def update_user(
        self, user_id: int, name: str | None = None, password: str | None = None
    ):
        user = self.user_repo.find_by_id(user_id)

        if name:
            user.name = name
        if password:
            user.password = self.hash_password(password)

        self.user_repo.update(user)

        return user

    def get_users(self, page: int, items_per_page: int) -> tuple[int, list[User]]:
        users = self.user_repo.get_users(page, items_per_page)
        return users

    def delete_user(self, user_id: int):
        return self.user_repo.delete(user_id)
