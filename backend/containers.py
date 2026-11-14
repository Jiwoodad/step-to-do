from dependency_injector import containers, providers
from app.user.infra.repository.user_repo import UserRepository
from app.user.services.user_service import UserService
from app.utils.crypto import Crypto


class Container(containers.DeclarativeContainer):
    wiring_config = containers.WiringConfiguration(packages=["app.user"])

    crypto = providers.Singleton(Crypto)
    user_repo = providers.Factory(UserRepository)
    user_service = providers.Factory(
        UserService,
        user_repo=user_repo,
        hash_password=crypto.provided.encrypt,
    )
