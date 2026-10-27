[English](SECURITY.md) · **한국어**

# 보안

Limit Tracker는 한 사람이 만드는 개인 프로젝트입니다. 보안 문제를 비공개로 알리는 방법, 앱이 PC에서 접근하는 것, 업데이트·배포 방식의 위험을 정리했습니다.

## 취약점 알리기

보안 문제는 공개 이슈로 올리지 마세요.

- **limittracker.app@gmail.com**으로 메일을 보내 주세요. 제목은 `Security:`로 시작해 주세요.
- 이 저장소의 **Security** 탭에 **Report a vulnerability**가 보이면 GitHub 비공개 취약점 신고를 이용해도 됩니다.

앱 버전(설정 → 정보), 발견한 내용, 재현 방법, 예상되는 영향을 적어 주세요. 비밀번호·토큰·로그인 정보 파일·iPhone 연결 주소는 절대 보내지 마세요. 로그와 화면 캡처에 이런 정보나 계정 이름, Windows 사용자 경로가 보이면 지워 주세요.

응답 시간은 보장하지 않습니다. 수정은 새 릴리스로 나가며 최신 릴리스만 지원합니다. 수정이 나간 뒤 신고자가 동의하면 이름을 밝히고 내용을 공개할 수 있습니다.

## 앱이 접근하는 것

### 파일

- **Claude Code 로그인**: `%USERPROFILE%\.claude`(또는 `CLAUDE_CONFIG_DIR`)의 `.credentials.json`.
  - 읽기·갱신: 이 파일을 읽습니다. 접근 토큰을 갱신할 때는 Claude Code와 같은 잠금 파일(`.oauth_refresh.lock`, `.storage-write.lock`)을 걸고 이 파일에 다시 씁니다.
  - 임시 복구 파일: 갱신으로 받은 새 토큰은 먼저 같은 폴더의 `.limit-tracker-refresh.json`에 저장하고, `.credentials.json`에 옮겨 적은 뒤 이 임시 파일을 지웁니다. 옮겨 적지 못하면 다음에 성공할 때까지 임시 파일을 남겨 둡니다.
  - 환경 변수: 파일에 로그인이 없으면 `CLAUDE_CODE_OAUTH_TOKEN` 환경 변수를 대신 씁니다(갱신하지 않음).
  - WSL: 둘 다 없으면 이미 실행 중인 WSL 배포판에서 같은 파일을 읽기만 하고 쓰지는 않습니다. 이 PC의 로그인을 쓰는 계정만 여기까지 찾습니다.
- **앱 폴더** `%APPDATA%\Limit Tracker`:
  - `settings.json`: 계정 이름, 표시할 계정, 환경설정, iPhone 페이지용 임의 키.
  - `accounts\`: 별도 로그인한 계정의 CLI 로그인 정보.
  - 그 밖: 알림 기록, 트레이 아이콘 캐시, 오류와 업데이트 내역을 남기는 `logs\main.log`.
- **암호화하지 않은 JSON**: `.credentials.json`, `.limit-tracker-refresh.json`, `settings.json`은 암호화하지 않은 JSON입니다. 같은 Windows 계정으로 실행되는 프로그램과 관리자가 읽을 수 있습니다.
- 앱은 Codex 로그인 파일을 읽지 않습니다.

### 프로그램

- **Codex CLI**: Codex 계정 유형과 사용 한도를 읽으려고 PC에 설치된 Codex CLI를 `codex app-server` 명령으로 실행합니다. 이때 Codex 분석 기능(analytics)은 끕니다.
- **로그인 창**: 자동 조회 계정에서 「로그인」을 누르면 보이는 Windows PowerShell 창에서 `claude auth login`이나 `codex login`을 실행합니다.
  - 이 창은 숨겨진 PowerShell이 `-EncodedCommand`(인코딩한 명령)와 `-ExecutionPolicy Bypass`로 띄웁니다. 명령줄을 고스란히 넘기기 위해서입니다.
- **`wsl.exe`**: 이미 실행 중인 WSL 배포판 목록을 보고 그 안의 Claude Code 로그인을 읽습니다. WSL을 시작하거나 설치하지는 않습니다.
- **Windows PowerShell**: 앱의 알림 이름과 아이콘을 `HKCU\Software\Classes\AppUserModelId\local.limittracker.desktop`에 등록합니다.
- **업데이트 설치 파일**: 내려받은 설치 파일은 설치를 직접 고를 때만 실행합니다. 설치 프로그램은 실행 중인 앱을 닫으려고 PowerShell이나 `taskkill`을 씁니다.

### 네트워크

- **Anthropic**: `api.anthropic.com`(Claude 사용량), `platform.claude.com`(Claude 토큰 갱신). Claude 토큰은 이 두 고정 HTTPS 주소로만 보내고, 리디렉션은 거부합니다.
- **OpenAI**: Codex CLI를 거쳐서만 연결합니다. 앱 자체는 OpenAI에 요청하지 않습니다.
- **GitHub**: 업데이트용 `github.com`과 GitHub 다운로드 서버.
- **iPhone 페이지**: 켤 때만 쓰는 로컬 네트워크 페이지(포트 43821, 아래 설명).

분석·원격 측정·충돌 보고는 없습니다.

### Windows

- **설치**: `%LOCALAPPDATA%\Programs` 아래 사용자별 설치, 시작 메뉴·바탕 화면 바로 가기.
- **「Windows 시작 시 실행」**: 켜면 Windows에 로그인할 때 앱이 자동으로 실행되도록 등록합니다.
- **알림 등록**: 위의 `AppUserModelId` 등록.
- **제거해도 남는 것**: `%APPDATA%\Limit Tracker`(설정, 별도 로그인한 계정의 로그인 정보), `%LOCALAPPDATA%\limit-tracker-updater`(내려받은 설치 파일), 알림 등록, 「Windows 시작 시 실행」을 켰다면 그 시작 항목.
  - 모두 지우려면 제거 전에 「Windows 시작 시 실행」을 끄세요. 제거한 뒤 두 폴더와 레지스트리 키 `HKCU\Software\Classes\AppUserModelId\local.limittracker.desktop`을 지우고, Claude Code 폴더(`%USERPROFILE%\.claude` 또는 `CLAUDE_CONFIG_DIR`)에 `.limit-tracker-refresh.json`이 남아 있다면 그것도 지우세요.

## 알려진 위험

### Claude 로그인 사용

Claude 자동 조회는 비공식 방식입니다. 제3자 앱인 Limit Tracker가 PC에 저장된 Claude Code 구독 로그인을 가져다 쓰고, 로그인이 풀리지 않도록 갱신합니다. 요청에는 Claude Code가 보낸 것처럼 Claude Code 식별값을 붙입니다. Anthropic의 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 문서는 제3자 앱이 Free·Pro·Max 로그인 정보를 이렇게 쓰는 것을 허용하지 않으며, 예고 없이 조치할 수 있다고 밝힙니다. 따라서 Claude 계정이 제한될 수 있습니다.

새로 설치하면 자동 Claude 계정이 기본으로 들어 있어, 이 PC에 Claude Code 로그인이 있으면 앱을 처음 켤 때부터 그 로그인으로 조회합니다. 이 위험을 피하려면 자동 Claude 계정을 삭제하고 「사용량 직접 입력」으로 다시 추가하세요.

### Gemini

1.5.6 이하 버전은 Gemini CLI 로그인으로 자동 조회했는데, Google의 [Gemini CLI 약관](https://www.geminicli.com/docs/resources/tos-privacy)은 제3자 소프트웨어가 이렇게 쓰는 것을 금지합니다. 1.6.0부터 Gemini는 직접 입력만 지원하며 그 로그인을 더 이상 읽지 않습니다.

1.5에서 Gemini를 별도 로그인으로 썼다면 예전 로그인 정보가 `%APPDATA%\Limit Tracker\accounts\<id>\gemini`에 남아 있으니 그 폴더를 지우세요. Gemini CLI를 더 쓰지 않는다면 Google 계정에 연결된 제3자 앱 목록에서 Gemini CLI의 접근 권한도 지우세요.

### iPhone 페이지

켜 두면 앱이 모든 네트워크 어댑터의 포트 43821에서 일반 HTTP로 읽기 전용 페이지를 제공합니다. 사설 IPv4 주소에만 응답하고, 사용량 데이터는 주소에 든 64자 키가 있어야 보여 줍니다. 연결이 암호화되지 않으므로 같은 네트워크에서 이 주소를 본 사람은 누구나 계정 이름, 요금제, 사용량, 로그인 기한, Codex 크레딧처럼 이 페이지에 보이는 내용을 읽을 수 있습니다. 믿을 수 없는 네트워크에서는 꺼 두세요.

키는 저절로 바뀌지 않습니다. 공유한 주소를 무효로 하려면 앱을 종료하고 `%APPDATA%\Limit Tracker\settings.json`에서 `"mobileKey": ""`로 바꾼 뒤 다시 실행하세요. 새 키와 주소가 만들어져 저장됩니다.

## 업데이트와 그 위험

1.6.0부터 업데이트는 이렇게 동작합니다.

1. 「새 버전 자동 확인」이 켜져 있으면(기본값) 시작 약 90초 뒤와 6시간마다 GitHub의 최신 릴리스를 확인합니다.
2. 새 버전은 백그라운드에서 `%LOCALAPPDATA%\limit-tracker-updater`에 내려받아 둡니다.
3. 설정 → 정보의 「지금 다시 시작해 적용」이나 트레이 메뉴의 「<버전> 업데이트 설치 후 다시 시작」을 누르기 전에는 아무것도 설치하지 않습니다. 시작·종료 때나 타이머로 설치하는 일도 없습니다.

1.5.x 설치본은 업데이트를 묻지 않고 설치하므로, 1.6.0 이상으로 넘어갈 때 한 번은 저절로 설치됩니다. 1.6.0부터는 사용자가 누르기 전에는 설치하지 않습니다. 「새 버전 자동 확인」을 끄면 자동 확인과 내려받기가 멈춥니다.

위험: 내려받은 파일은 같은 GitHub 릴리스의 `latest.yml`에 적힌 SHA-512로만 확인하며, 설치 파일에는 코드 서명이 없습니다. 제작자의 GitHub 계정이나 빌드 PC가 뚫리면 악성 릴리스도 이 확인을 통과합니다. 설치 전에 묻기 때문에 릴리스 노트를 읽고 기다려 볼 수는 있습니다. 하지만 릴리스가 진짜인지 증명해 주지는 못합니다.

## 서명 없는 설치 파일

설치 파일에 코드 서명 인증서가 없어 Windows SmartScreen이나 스마트 앱 컨트롤이 경고하거나 막을 수 있습니다. 같은 소스로 빌드해도 똑같은 파일이 나오지 않아(재현 가능한 빌드가 아님), 배포된 설치 파일과 직접 빌드한 파일을 그대로 비교할 수는 없습니다.

할 수 있는 것:

- [릴리스 페이지](https://github.com/nowsummer/Limit-Tracker/releases)의 각 파일 옆 `sha256:` 값과 PowerShell의 `Get-FileHash .\Limit-Tracker-<version>.exe -Algorithm SHA256` 결과를 비교하세요. 같으면 릴리스 페이지의 그 파일이라는 뜻이지, 이 소스로 빌드됐다는 뜻은 아닙니다.
- 소스를 읽고 직접 빌드하세요([README](README.ko.md) 참고). 직접 빌드해 설치한 사본도 이 저장소의 새 릴리스를 내려받고, 설치를 누르면 내 빌드가 배포본으로 바뀝니다. 직접 빌드한 사본을 계속 쓰려면 「새 버전 자동 확인」을 끄세요.
