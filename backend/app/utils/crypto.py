from pwdlib import PasswordHash


class Crypto:
    def __init__(self):
        # argon2. bcrypt와 달리 72바이트 제한이 없어 한글 64자 비밀번호도 잘리지 않는다.
        self.pwd_context = PasswordHash.recommended()

    def encrypt(self, secret):
        return self.pwd_context.hash(secret)

    def verify(self, secret, hash):
        return self.pwd_context.verify(secret, hash)
