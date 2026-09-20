#!/usr/bin/env bash
# 도면 파일을 drawingtool 저장소에서 가져온다.
#
# 원본은 D:/dev/drawingtool 이고 SaaS 는 사본을 서빙한다. 같은 출처여야
# /api/drawings 저장이 동작하므로 사본이 필요하다 — drawingtool.agonyang.com 은
# nginx 가 정적 파일만 서빙해 저장이 조용히 사라진다.
#
# 사본이 낡으면 도면 계산 수정이 SaaS 에만 빠진 채로 운영된다. 실제로
# 210KB 사본이 262KB 원본보다 넉 달 뒤처져 있었다.
#
#   ./tools/sync-drawing.sh            # 복사
#   ./tools/sync-drawing.sh --check    # 차이만 확인 (CI/배포 전)

set -eu

SRC="${DRAWINGTOOL_DIR:-/d/dev/drawingtool}"
DST="$(cd "$(dirname "$0")/.." && pwd)"
FILES="drawing_app.html drawing_base.js drawing_checkplate.js"

if [ ! -d "$SRC" ]; then
  echo "drawingtool 저장소를 찾을 수 없습니다: $SRC" >&2
  echo "DRAWINGTOOL_DIR 로 경로를 지정하세요." >&2
  exit 1
fi

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
DIFF=0

for f in $FILES; do
  if [ ! -f "$SRC/$f" ]; then echo "원본 없음: $SRC/$f" >&2; exit 1; fi
  if ! cmp -s "$SRC/$f" "$DST/$f" 2>/dev/null; then
    DIFF=1
    if [ "$CHECK" = "1" ]; then
      echo "다름: $f (원본 $(wc -c < "$SRC/$f") B / 사본 $(wc -c < "$DST/$f" 2>/dev/null || echo 0) B)"
    else
      cp "$SRC/$f" "$DST/$f"
      echo "복사: $f"
    fi
  fi
done

if [ "$CHECK" = "1" ]; then
  [ "$DIFF" = "0" ] && { echo "도면 파일 최신"; exit 0; }
  echo "도면 파일이 원본과 다릅니다. ./tools/sync-drawing.sh 로 동기화하세요." >&2
  exit 1
fi

[ "$DIFF" = "0" ] && echo "이미 최신입니다."
exit 0
