from abc import ABCMeta, abstractmethod
from app.user.domain.model import User


class IUserRepository(metaclass=ABCMeta):
    @abstractmethod
    def save(self, user: User):
        raise NotImplementedError

    @abstractmethod
    def find_by_email(self, email: str):
        """
        이메일로 유저 검색
        검색된 이메일이 없을 경우 422 에러
        """
        raise NotImplementedError

    @abstractmethod
    def validate_email_format(self, email: str):
        """
        올바른 이메일 형식인지 검증
        - 앞뒤 공백 제거 후 1~254자, `이름@도메인.최상위` 형식인지 본다
        - 형식만 검사한다. 도메인 실재 여부(DNS·MX)는 보지 않는다
          (메일 도착 여부는 인증코드로 확인)
        - 형식이 틀리면 422 에러. 본문은 Pydantic 기본 형식
          (`detail` 배열, `loc: ["body", "email"]`)이어야 화면이 이메일 칸에 표시한다
          → 문자열 detail의 HTTPException(422)이 아니라
            요청 스키마의 `EmailStr` 검증(RequestValidationError)으로 처리하는 것을 권장
        """
        raise NotImplementedError

    @abstractmethod
    def find_by_id(self, id: int):
        raise NotImplementedError

    @abstractmethod
    def update(self, user: User):
        raise NotImplementedError

    @abstractmethod
    def get_users(self, page: int, items_per_page: int) -> tuple[int, list[User]]:
        raise NotImplementedError

    @abstractmethod
    def delete(self, id: int):
        raise NotImplementedError
