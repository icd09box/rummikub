# 루미큐브 (Rummikub) — 웹 버전

브라우저에서 바로 하는 루미큐브. 2~4인, 한 기기에서 번갈아 플레이(핫시트)하며 자리마다 사람/CPU 선택 가능.
빌드 없이 정적 파일만 있어 GitHub Pages에 그대로 올라간다.

## 실행
```bash
python3 -m http.server 8080   # 그 다음 http://localhost:8080
node --test test/*.test.js    # 규칙·게임 로직 테스트
```

## 구조
- `js/rules.js` — 세트 판정(그룹/런/조커), 턴 검증, 점수. 순수 함수.
- `js/cpu.js` — 단순 CPU(손패 세트 탐욕 선택 + 테이블 덧붙이기).
- `js/game.js` — 게임 상태(배분·턴·뽑기·종료·점수).
- `js/app.js` — 화면(설정 / 기기 넘기기 / 게임 / 결과).
- `test/` — node:test.

## GitHub Pages 배포
저장소 Settings → Pages → Source: `main` / root. `index.html`이 루트에 있으면 끝.
