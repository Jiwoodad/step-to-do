from typing import Annotated
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from dependency_injector.wiring import inject, Provide

from app.user.infra.repository.user_repo import UserRepository
from app.user.services.user_service import UserService
from app.utils.crypto import Crypto
from containers import Container

router = APIRouter(prefix="/users")


class CreateUserBody(BaseModel):
    email: str
    password: str


@router.post("", status_code=201)
@inject
def create_user(
    user: CreateUserBody,
    user_service: UserService = Depends(Provide[Container.user_service]),
):
    created_user = user_service.create_user(email=user.email, password=user.password)
    return created_user
