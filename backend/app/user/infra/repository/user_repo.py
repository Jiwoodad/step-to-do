from email_validator import EmailNotValidError, validate_email
from fastapi.exceptions import RequestValidationError
from fastapi import HTTPException

from database import SessionLocal
from app.user.domain.repository.user_repo import IUserRepository
from app.user.domain.model import User as UserVO
from app.user.infra.db_models.user import User
from utils.db_utils import row_to_dict


class UserRepository(IUserRepository):
    def save(self, user: UserVO):
        new_user = User(id=user.id, email=user.email, password=user.password)

        with SessionLocal() as db:
            try:
                db = SessionLocal()
                db.add(new_user)
                db.commit()
            finally:
                db.close()

    def find_by_email(self, email: str) -> User:
        with SessionLocal() as db:
            user = db.query(User).filter(User.email == email).first()

        if not user:
            raise HTTPException(status_code=422)

        return UserVO(**row_to_dict(user))

    def validate_email_format(self, email: str):
        try:
            # 형식·길이(254자)만 검사. DNS·MX 조회는 하지 않는다
            validate_email(email.strip(), check_deliverability=False)
        except EmailNotValidError as e:
            # 스키마 검증 실패와 같은 경로로 보내 `loc: ["body", "email"]` 형식을 맞춘다
            raise RequestValidationError(
                [
                    {
                        "type": "value_error",
                        "loc": ("body", "email"),
                        "msg": f"value is not a valid email address: {e}",
                        "input": email,
                    }
                ]
            )
