from dependency_injector import containers, providers
from app.user.infra.repository.user_repo import UserRepository
from app.user.services.user_service import UserService


class Container(containers.DeclarativeContainer):
    wiring_config = containers.WiringConfiguration(packages=["app.user"])

    user_repo = providers.Factory(UserRepository)
    user_service = providers.Factory(UserService, user_repo=user_repo)
