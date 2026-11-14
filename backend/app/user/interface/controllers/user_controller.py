from typing import Annotated
from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints
from dependency_injector.wiring import inject, Provide

from app.user.infra.repository.user_repo import UserRepository
from app.user.services.user_service import UserService
from app.utils.crypto import Crypto
from containers import Container

router = APIRouter(prefix="/users")


class CreateUserBody(BaseModel):
    email: str
    password: str
    # 앞뒤 공백을 지운 뒤 1~20자 (API.md §2.6). 위반하면 422, loc: ["body", "name"]
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)
    ]


class UpdateUserBody(BaseModel):
    name: str | None = None
    password: str | None = None


@router.post("", status_code=201)
@inject
def create_user(
    user: CreateUserBody,
    user_service: UserService = Depends(Provide[Container.user_service]),
):
    created_user = user_service.create_user(
        email=user.email, password=user.password, name=user.name
    )
    return created_user


@router.put("/{user_id}")
@inject
def update_user(
    user_id: str,
    user: UpdateUserBody,
    user_service: UserService = Depends(Provide[Container.user_service]),
):
    user = user_service.update_user(
        user_id=user_id,
        name=user.name,
        password=user.password,
    )

    return user


@router.get("")
@inject
def get_users(
    page: int = 1,
    items_per_page: int = 10,
    user_service: UserService = Depends(Provide[Container.user_service]),
):

    total_count, users = user_service.get_users(page, items_per_page)

    return {"total_counts": total_count, "page": page, "users": users}


@router.delete("", status_code=204)
@inject
def delete_user(
    user_id: int,
    user_service: UserService = Depends(Provide[Container.user_service]),
):
    user_service.delete_user(user_id)
