// drawing_checkplate.js — 바닥 체크판(Checkplate) 렌더링
// 전역 의존: ctx, doors, thicknessIn (drawing_app.html에서 정의)
// DOM 의존: #sheetW, #sheetL, #checkplate-bom-total, #checkplate-bom-tbody

function renderCheckPlateMode(w, l, t, ox, oy, scale, dw, dl, dt) {
    // 내부 면적
    const edgeGap = 5;
    const iw = Math.max(0, w - t * 2 - edgeGap * 2);  // 체크판 가로
    const il = Math.max(0, l - t * 2 - edgeGap * 2);  // 체크판 세로

    const sheetW = parseInt(document.getElementById('sheetW').value) || 1219;
    const sheetL = parseInt(document.getElementById('sheetL').value) || 2438;
    const activeColumns = getCheckplateBlockers(w, l, t, edgeGap, iw, il);
    const doorWall = (typeof doors !== 'undefined' && doors.length > 0)
        ? doors[0].wallIndex : 0;
    // wallIndex: 0=하단, 1=우측, 2=상단, 3=좌측
    const flip_x = (doorWall === 1);  // 도어 우측 → 쪽판 좌측
    const flip_y = (doorWall === 0);  // 도어 하단 → 쪽판 상단(y=0)

    // ----------------------------------------------------------------
    // calcLayout(sw, sl, iw, il) — 단방향 레이아웃 계산
    // ----------------------------------------------------------------
    function calcLayout(sw, sl, iw, il, blockedColumns) {
        const cols_full = Math.floor(iw / sw);
        const rem_w     = iw % sw;   // 우측 쪽판 너비
        const rows_full = Math.floor(il / sl);
        const rem_l     = il % sl;   // 하단 쪽판 높이

        const full_sheets   = cols_full * rows_full;
        const cut_w_sheets  = (rem_w > 0 && rows_full > 0)
            ? Math.ceil(rows_full / Math.floor(sw / rem_w)) : 0;
        const cut_l_sheets  = (rem_l > 0 && cols_full > 0)
            ? Math.ceil(cols_full / Math.floor(sl / rem_l)) : 0;
        const corner_sheets = (rem_w > 0 && rem_l > 0 && cut_w_sheets === 0 && cut_l_sheets === 0)
            ? 1 : 0;
        // piece 좌표 배열
        const basePieces = [];
        for (let col = 0; col < cols_full; col++) {
            for (let row = 0; row < rows_full; row++) {
                basePieces.push({ type: 'full', sourceType: 'full', sourceId: `full-${col}-${row}`, x: col * sw, y: row * sl, w: sw, h: sl });
            }
        }
        if (rem_w > 0 && rows_full > 0) {
            for (let row = 0; row < rows_full; row++) {
                basePieces.push({ type: 'cut_w', sourceType: 'cut_w', sourceId: `cut_w-${row}`, x: cols_full * sw, y: row * sl, w: rem_w, h: sl });
            }
        }
        if (rem_l > 0 && cols_full > 0) {
            for (let col = 0; col < cols_full; col++) {
                basePieces.push({ type: 'cut_l', sourceType: 'cut_l', sourceId: `cut_l-${col}`, x: col * sw, y: rows_full * sl, w: sw, h: rem_l });
            }
        }
        if (rem_w > 0 && rem_l > 0) {
            basePieces.push({ type: 'cut_corner', sourceType: 'cut_corner', sourceId: 'cut_corner-0', x: cols_full * sw, y: rows_full * sl, w: rem_w, h: rem_l });
        }
        const flippedBasePieces = basePieces.map(p => ({
            ...p,
            x: flip_x ? iw - p.x - p.w : p.x,
            y: flip_y ? il - p.y - p.h : p.y,
        }));
        const pieces = flippedBasePieces.flatMap(p => splitPieceByColumns(p, blockedColumns));

        // BOM 행 (count > 0인 행만)
        const sourceCounts = countRemainingSources(pieces);
        const adjustedFullSheets = sourceCounts.full;
        const adjustedCutWSheets = (rem_w > 0 && sourceCounts.cut_w > 0)
            ? Math.ceil(sourceCounts.cut_w / Math.max(1, Math.floor(sw / rem_w))) : 0;
        const adjustedCutLSheets = (rem_l > 0 && sourceCounts.cut_l > 0)
            ? Math.ceil(sourceCounts.cut_l / Math.max(1, Math.floor(sl / rem_l))) : 0;
        const adjustedCornerSheets = sourceCounts.cut_corner > 0 && adjustedCutWSheets === 0 && adjustedCutLSheets === 0
            ? 1 : 0;
        const adjustedTotalSheets = adjustedFullSheets + adjustedCutWSheets + adjustedCutLSheets + adjustedCornerSheets;
        const bom = buildBomFromPieces(pieces, adjustedTotalSheets);

        return { cols_full, rows_full, rem_w, rem_l,
                 full_sheets: adjustedFullSheets, cut_w_sheets: adjustedCutWSheets,
                 cut_l_sheets: adjustedCutLSheets, corner_sheets: adjustedCornerSheets,
                 total_sheets: adjustedTotalSheets, pieces, bom,
                 sw, sl };
    }

    function countRemainingSources(pieces) {
        const byType = { full: new Set(), cut_w: new Set(), cut_l: new Set(), cut_corner: new Set() };
        pieces.forEach(piece => {
            if (byType[piece.sourceType]) byType[piece.sourceType].add(piece.sourceId);
        });
        return {
            full: byType.full.size,
            cut_w: byType.cut_w.size,
            cut_l: byType.cut_l.size,
            cut_corner: byType.cut_corner.size
        };
    }

    function buildBomFromPieces(pieces, sheetCount) {
        const names = {
            full: '온장',
            cut_w: '세로 쪽판',
            cut_l: '가로 쪽판',
            cut_corner: '코너 쪽판'
        };
        const rows = [];
        pieces.forEach(piece => {
            const dim = `${Math.round(piece.w)}×${Math.round(piece.h)}`;
            const label = piece.cutByColumn ? `${names[piece.sourceType] || '조각'}(기둥 절단)` : (names[piece.sourceType] || '조각');
            const cutKey = getCutKey(piece);
            const found = rows.find(row => row.label === label && row.dim === dim && row.cutKey === cutKey);
            if (found) found.count += 1;
            else rows.push({ label, dim, cutKey, count: 1, sheets: '' });
        });
        rows.sort((a, b) => a.label.localeCompare(b.label, 'ko') || a.dim.localeCompare(b.dim, 'ko'));
        if (rows.length > 0) rows[0].sheets = sheetCount;
        return rows;
    }

    function getCutKey(piece) {
        return (piece.cuts || [])
            .map(cut => `${Math.round(cut.x - piece.x)},${Math.round(cut.y - piece.y)},${Math.round(cut.w)},${Math.round(cut.h)}`)
            .sort()
            .join('|');
    }

    function getCheckplateBlockers(roomW, roomL, thickness, gap, innerW, innerL) {
        if (typeof columns === 'undefined') return [];
        return columns
            .map(col => {
                const rect = getExpandedColumnRect(col, roomW, roomL, thickness, gap);
                return {
                    type: 'column-expanded',
                    x1: Math.max(0, Math.min(innerW, rect.x1 - thickness - gap)),
                    x2: Math.max(0, Math.min(innerW, rect.x2 - thickness - gap)),
                    y1: Math.max(0, Math.min(innerL, rect.y1 - thickness - gap)),
                    y2: Math.max(0, Math.min(innerL, rect.y2 - thickness - gap))
                };
            })
            .filter(col => col.x2 - col.x1 > 0.5 && col.y2 - col.y1 > 0.5);
    }

    function getExpandedColumnRect(col, roomW, roomL, thickness, gap = 0) {
        return {
            x1: Math.max(0, col.x - thickness - gap),
            y1: Math.max(0, col.y - thickness - gap),
            x2: Math.min(roomW, col.x + col.width + thickness + gap),
            y2: Math.min(roomL, col.y + col.depth + thickness + gap)
        };
    }

    function getColumnAndWrapRects(col, roomW, roomL, thickness) {
        const x = col.x, y = col.y, width = col.width, depth = col.depth;
        const rects = [{ type: 'column', x1: x, y1: y, x2: x + width, y2: y + depth }];

        const touchesTop    = y < thickness;
        const touchesBottom = y + depth > roomL - thickness;
        const touchesLeft   = x < thickness;
        const touchesRight  = x + width > roomW - thickness;
        const touchesAnyWall = touchesTop || touchesBottom || touchesLeft || touchesRight;
        if (!touchesAnyWall) return rects;

        const needLeftWrap  = x > thickness;
        const needRightWrap = x + width < roomW - thickness;
        const needTopWrap   = y > thickness;
        const needBotWrap   = y + depth < roomL - thickness;
        const cc = col.colCorners || {};
        const cTL_v = cc.TL === 'v', cTR_v = cc.TR === 'v';
        const cBL_v = cc.BL === 'v', cBR_v = cc.BR === 'v';

        const clampX1 = (v, ext, touchWall, noWrap) =>
            Math.max(0, (touchWall && noWrap && ext === 0) ? Math.max(v, thickness) : v);
        const clampX2 = (v, ext, touchWall, noWrap) =>
            Math.min(roomW, (touchWall && noWrap && ext === 0) ? Math.min(v, roomW - thickness) : v);
        const clampY1 = (v, ext, touchWall, noWrap) =>
            Math.max(0, (touchWall && noWrap && ext === 0) ? Math.max(v, thickness) : v);
        const clampY2 = (v, ext, touchWall, noWrap) =>
            Math.min(roomL, (touchWall && noWrap && ext === 0) ? Math.min(v, roomL - thickness) : v);
        const pushRect = (x1, y1, x2, y2) => {
            if (x2 - x1 > 0.5 && y2 - y1 > 0.5) rects.push({ type: 'wrap', x1, y1, x2, y2 });
        };

        if (needRightWrap) {
            const topExt = ((needTopWrap || touchesTop)    && cTR_v) ? thickness : 0;
            const botExt = ((needBotWrap || touchesBottom) && cBR_v) ? thickness : 0;
            pushRect(
                x + width,
                clampY1(y - topExt, topExt, touchesTop, !needTopWrap),
                x + width + thickness,
                clampY2(y + depth + botExt, botExt, touchesBottom, !needBotWrap)
            );
        }
        if (needLeftWrap) {
            const topExt = ((needTopWrap || touchesTop)    && cTL_v) ? thickness : 0;
            const botExt = ((needBotWrap || touchesBottom) && cBL_v) ? thickness : 0;
            pushRect(
                x - thickness,
                clampY1(y - topExt, topExt, touchesTop, !needTopWrap),
                x,
                clampY2(y + depth + botExt, botExt, touchesBottom, !needBotWrap)
            );
        }
        if (needBotWrap) {
            const extL = ((needLeftWrap  || touchesLeft)  && !cBL_v) ? thickness : 0;
            const extR = ((needRightWrap || touchesRight) && !cBR_v) ? thickness : 0;
            pushRect(
                clampX1(x - extL, extL, touchesLeft, !needLeftWrap),
                y + depth,
                clampX2(x + width + extR, extR, touchesRight, !needRightWrap),
                y + depth + thickness
            );
        }
        if (needTopWrap) {
            const extL = ((needLeftWrap  || touchesLeft)  && !cTL_v) ? thickness : 0;
            const extR = ((needRightWrap || touchesRight) && !cTR_v) ? thickness : 0;
            pushRect(
                clampX1(x - extL, extL, touchesLeft, !needLeftWrap),
                y - thickness,
                clampX2(x + width + extR, extR, touchesRight, !needRightWrap),
                y
            );
        }

        return rects;
    }

    function splitPieceByColumns(piece, blockedColumns) {
        let parts = [piece];
        blockedColumns.forEach(col => {
            const nextParts = [];
            parts.forEach(part => nextParts.push(...subtractRect(part, col)));
            parts = nextParts;
        });
        return parts;
    }

    function subtractRect(rect, cut) {
        const eps = 0.5;
        const ix1 = Math.max(rect.x, cut.x1);
        const iy1 = Math.max(rect.y, cut.y1);
        const ix2 = Math.min(rect.x + rect.w, cut.x2);
        const iy2 = Math.min(rect.y + rect.h, cut.y2);
        if (ix2 - ix1 <= eps || iy2 - iy1 <= eps) return [rect];

        const parts = [];
        const push = (x, y, width, height) => {
            if (width > eps && height > eps) {
                parts.push({ ...rect, x, y, w: width, h: height, cutByColumn: true });
            }
        };

        push(rect.x, rect.y, rect.w, iy1 - rect.y);
        push(rect.x, iy2, rect.w, rect.y + rect.h - iy2);
        push(rect.x, iy1, ix1 - rect.x, iy2 - iy1);
        push(ix2, iy1, rect.x + rect.w - ix2, iy2 - iy1);
        return parts;
    }

    // 최적 방향 선택 (총 원장 수 최소)
    const layoutA = calcLayout(sheetW, sheetL, iw, il, activeColumns);
    const layoutB = calcLayout(sheetL, sheetW, iw, il, activeColumns);
    const layout  = layoutA.total_sheets <= layoutB.total_sheets ? layoutA : layoutB;

    const pieces = layout.pieces;

    // ----------------------------------------------------------------
    // 색상 정의
    // ----------------------------------------------------------------
    const PIECE_COLORS = {
        full:       { fill: '#f8fafc', stroke: '#64748b' },
        cut_w:      { fill: '#dbeafe', stroke: '#3b82f6' },
        cut_l:      { fill: '#dcfce7', stroke: '#22c55e' },
        cut_corner: { fill: '#fef3c7', stroke: '#f59e0b' },
    };

    // 체크판 시작 좌표 (벽 안쪽에서 사방 5mm 여유)
    const ix = ox + (t + edgeGap) * scale;
    const iy = oy + (t + edgeGap) * scale;

    // ----------------------------------------------------------------
    // 1. 외경 점선 참조선
    // ----------------------------------------------------------------
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, dw, dl);
    ctx.setLineDash([]);

    // ----------------------------------------------------------------
    // 2. 내부 흰색 배경
    // ----------------------------------------------------------------
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ix, iy, iw * scale, il * scale);

    // ----------------------------------------------------------------
    // 3 & 4. 각 piece 그리기 + 규격 라벨
    // ----------------------------------------------------------------
    pieces.forEach(p => {
        const px  = ix + p.x * scale;
        const py  = iy + p.y * scale;
        const pxW = p.w * scale;
        const pxH = p.h * scale;
        const color = PIECE_COLORS[p.type];

        // fill + stroke
        ctx.fillStyle = color.fill;
        ctx.fillRect(px, py, pxW, pxH);
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, pxW, pxH);

        (p.cuts || []).forEach(cut => {
            const cx1 = Math.max(p.x, cut.x);
            const cy1 = Math.max(p.y, cut.y);
            const cx2 = Math.min(p.x + p.w, cut.x + cut.w);
            const cy2 = Math.min(p.y + p.h, cut.y + cut.h);
            if (cx2 - cx1 <= 0.5 || cy2 - cy1 <= 0.5) return;

            const cutX = ix + cx1 * scale;
            const cutY = iy + cy1 * scale;
            const cutW = (cx2 - cx1) * scale;
            const cutH = (cy2 - cy1) * scale;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cutX, cutY, cutW, cutH);
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.2;
            ctx.strokeRect(cutX, cutY, cutW, cutH);
            ctx.restore();
        });

        // 규격 라벨 (크기 충분할 때만)
        if (pxW > 40 && pxH > 20) {
            if (typeof drawFixedLabel === 'function') {
                drawFixedLabel(px + pxW / 2, py + pxH / 2, `${p.w}x${p.h}`, { font: '9px sans-serif', color: '#475569', bg: 'rgba(255,255,255,0.78)' });
                return;
            }
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#475569';
            ctx.fillText(`${p.w}×${p.h}`, px + pxW / 2, py + pxH / 2);
        }
    });

    if (typeof columns !== 'undefined') {
        columns.forEach(col => {
            const expanded = getExpandedColumnRect(col, w, l, t, edgeGap);
            const ex = ox + expanded.x1 * scale;
            const ey = oy + expanded.y1 * scale;
            const ew = (expanded.x2 - expanded.x1) * scale;
            const eh = (expanded.y2 - expanded.y1) * scale;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(ex, ey, ew, eh);
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(ex, ey, ew, eh);
            const cx = ox + col.x * scale;
            const cy = oy + col.y * scale;
            const cw = col.width * scale;
            const cd = col.depth * scale;
            ctx.fillStyle = '#475569';
            ctx.fillRect(cx, cy, cw, cd);
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 2;
            ctx.strokeRect(cx, cy, cw, cd);
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + cw, cy + cd);
            ctx.moveTo(cx + cw, cy);
            ctx.lineTo(cx, cy + cd);
            ctx.stroke();
            const labelTxt = `${Math.round(col.width)}x${Math.round(col.depth)}`;
            ctx.font = 'bold 9px sans-serif';
            const tw = ctx.measureText(labelTxt).width;
            const z = typeof canvasZoom !== 'undefined' ? canvasZoom : 1;
            if (cw * z > tw + 4 && cd * z > 14 && typeof drawFixedLabel === 'function') {
                drawFixedLabel(cx + cw / 2, cy + cd / 2, labelTxt, { color: '#1e293b', bg: 'rgba(255,255,255,0.82)' });
            }
        });
    }

    // ----------------------------------------------------------------
    // 5. 치수선 (내부 면적 기준, drawing_base.js 스타일 동일)
    // ----------------------------------------------------------------
    const dimOffset = 44;
    ctx.save();
    if (typeof toViewportX === 'function' && typeof toViewportY === 'function') {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const vx1 = typeof toViewportX === 'function' ? toViewportX(ix) : ix;
    const vx2 = typeof toViewportX === 'function' ? toViewportX(ix + iw * scale) : ix + iw * scale;
    const vy1 = typeof toViewportY === 'function' ? toViewportY(iy) : iy;
    const vy2 = typeof toViewportY === 'function' ? toViewportY(iy + il * scale) : iy + il * scale;
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;

    // 가로치수(W): 하단 offset 44px
    const dimY = vy2 + dimOffset;
    ctx.beginPath(); ctx.moveTo(vx1, vy2 + 4); ctx.lineTo(vx1, dimY + 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(vx2, vy2 + 4); ctx.lineTo(vx2, dimY + 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(vx1, dimY); ctx.lineTo(vx2, dimY); ctx.stroke();
    ctx.fillStyle = '#334155';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('W = ' + Math.round(iw).toLocaleString() + ' mm', (vx1 + vx2) / 2, dimY + 3);

    // 세로치수(L): 우측 offset 44px, -90도 회전
    const dimX = vx2 + dimOffset;
    ctx.beginPath(); ctx.moveTo(vx2 + 4, vy1); ctx.lineTo(dimX + 2, vy1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(vx2 + 4, vy2); ctx.lineTo(dimX + 2, vy2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dimX, vy1); ctx.lineTo(dimX, vy2); ctx.stroke();
    ctx.translate(dimX + 4, (vy1 + vy2) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#334155';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('L = ' + Math.round(il).toLocaleString() + ' mm', 0, 0);
    ctx.restore();

    // ----------------------------------------------------------------
    // 6. 범례 (도면 왼쪽)
    // ----------------------------------------------------------------
    const legendX = ox - 88;   // 도면 좌측 가장자리 기준 왼쪽으로 배치
    const legendY = oy + 8;
    const legendItems = [
        { type: 'full',       label: '온장' },
        { type: 'cut_w',      label: '세로 쪽판' },
        { type: 'cut_l',      label: '가로 쪽판' },
        { type: 'cut_corner', label: '코너 쪽판' },
    ];
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    legendItems.forEach((item, i) => {
        const ly = legendY + i * 18;
        const color = PIECE_COLORS[item.type];
        ctx.fillStyle = color.fill;
        ctx.fillRect(legendX, ly, 12, 12);
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(legendX, ly, 12, 12);
        ctx.fillStyle = '#475569';
        ctx.fillText(item.label, legendX + 16, ly + 1);
    });

    // ----------------------------------------------------------------
    // DOM BOM 업데이트
    // ----------------------------------------------------------------
    const bomTbody = document.getElementById('checkplate-bom-tbody');
    const bomTotal = document.getElementById('checkplate-bom-total');
    if (bomTbody && bomTotal) {
        bomTotal.innerText = layout.total_sheets + '장';
        bomTbody.innerHTML = layout.bom.map((row, i) =>
            `<tr style="background:${i % 2 === 0 ? '#f8fafc' : '#fff'}">
                <td style="padding:4px 14px;border-bottom:1px solid #e2e8f0">${row.label}</td>
                <td style="padding:4px 14px;text-align:center;border-bottom:1px solid #e2e8f0;color:#64748b">${row.dim}</td>
                <td style="padding:4px 14px;text-align:center;border-bottom:1px solid #e2e8f0">${row.count}개</td>
                <td style="padding:4px 14px;text-align:center;border-bottom:1px solid #e2e8f0;font-weight:900">${row.sheets !== '' ? row.sheets + '장' : ''}${row.note ? '<span style="color:#10b981;font-size:9px;margin-left:4px">' + row.note + '</span>' : ''}</td>
            </tr>`
        ).join('');
    }

    // ----------------------------------------------------------------
    // 절단 도면 렌더링
    // ----------------------------------------------------------------
    renderCutDiagrams(layout);
}

// ----------------------------------------------------------------
// renderCutDiagrams(layout) — 절단 쪽판 SVG 도면 카드 렌더링
// 표시 방식: 장수(파란 글씨) → SVG → 종류+규격 라벨
// ----------------------------------------------------------------
function renderCutDiagrams(layout) {
    const container = document.getElementById('cut-diagrams-container');
    if (!container) return;
    container.innerHTML = '';

    const { sw, sl, rem_w, rem_l, rows_full, cols_full,
            full_sheets, cut_w_sheets, cut_l_sheets, corner_sheets } = layout;

    const MAX_W = 130, MAX_H = 190;

    function getPieceCutKey(piece) {
        return (piece.cuts || [])
            .map(cut => `${Math.round(cut.x - piece.x)},${Math.round(cut.y - piece.y)},${Math.round(cut.w)},${Math.round(cut.h)}`)
            .sort()
            .join('|');
    }

    // ── SVG 헬퍼: 원장(sw×sl) 배경 + 색깔 조각 + 절단선 ──
    // cutLines: { dir:'v'|'h', pos, from?, to? }
    //   from/to: 절단선의 시작·끝 좌표(mm). 미지정 시 전체 길이.
    //   방향 'v' → from/to는 y축(위→아래), 'h' → from/to는 x축(좌→우)
    function makeSVG(sheetW, sheetH, pieces, cutLines) {
        const sc = Math.min(MAX_W / sheetW, MAX_H / sheetH);
        const W = Math.round(sheetW * sc), H = Math.round(sheetH * sc);
        const rects = pieces.map(p =>
            `<rect x="${Math.round(p.x*sc)}" y="${Math.round(p.y*sc)}" width="${Math.round(p.w*sc)}" height="${Math.round(p.h*sc)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1"/>`
        ).join('');
        const lines = (cutLines||[]).map(cl => {
            if (cl.dir === 'v') {
                const x  = Math.round(cl.pos  * sc);
                const y1 = cl.from !== undefined ? Math.round(cl.from * sc) : 0;
                const y2 = cl.to   !== undefined ? Math.round(cl.to   * sc) : H;
                return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3"/>`;
            } else {
                const y  = Math.round(cl.pos  * sc);
                const x1 = cl.from !== undefined ? Math.round(cl.from * sc) : 0;
                const x2 = cl.to   !== undefined ? Math.round(cl.to   * sc) : W;
                return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3"/>`;
            }
        }).join('');
        return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>${rects}${lines}</svg>`;
    }

    // ── 카드 헬퍼: 장수(위, 파란) + SVG + 라벨(아래) ──
    // labels = [{ name:'가로 쪽판', dim:'1000×1800' }, ...]
    function makeCard(sheetCount, svgHtml, labels) {
        const cntTxt = `${sheetCount}장`;   // "N장" (동일 제거)
        const labelsHtml = labels.map(l =>
            `<p style="font-size:11px;font-weight:900;color:#1e293b;margin:0">${l.name} 1장</p>` +
            `<p style="font-size:10px;color:#64748b;margin:0 0 2px">${l.dim}mm</p>`
        ).join('');
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 12px">` +
            `<p style="font-size:12px;font-weight:900;color:#3b82f6;margin:0">${cntTxt}</p>` +
            svgHtml +
            `<div style="text-align:center;line-height:1.6">${labelsHtml}</div>` +
            `</div>`;
    }

    function renderActualPieceCards() {
        const colors = {
            full:       { fill: '#f8fafc', stroke: '#64748b', name: '온장' },
            cut_w:      { fill: '#dbeafe', stroke: '#3b82f6', name: '세로 쪽판' },
            cut_l:      { fill: '#dcfce7', stroke: '#22c55e', name: '가로 쪽판' },
            cut_corner: { fill: '#fef3c7', stroke: '#f59e0b', name: '코너 쪽판' },
        };
        function makeActualPieceSVG(piece, meta) {
            const sc = Math.min(130 / piece.w, 190 / piece.h);
            const W = Math.round(piece.w * sc);
            const H = Math.round(piece.h * sc);
            const cutRects = (piece.cuts || []).map(cut => {
                const cx1 = Math.max(piece.x, cut.x);
                const cy1 = Math.max(piece.y, cut.y);
                const cx2 = Math.min(piece.x + piece.w, cut.x + cut.w);
                const cy2 = Math.min(piece.y + piece.h, cut.y + cut.h);
                if (cx2 - cx1 <= 0.5 || cy2 - cy1 <= 0.5) return '';
                return `<rect x="${Math.round((cx1 - piece.x) * sc)}" y="${Math.round((cy1 - piece.y) * sc)}" width="${Math.round((cx2 - cx1) * sc)}" height="${Math.round((cy2 - cy1) * sc)}" fill="#fff" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3"/>`;
            }).join('');
            return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
                `<rect width="${W}" height="${H}" fill="${meta.fill}" stroke="${meta.stroke}" stroke-width="1"/>` +
                cutRects +
                `</svg>`;
        }
        const groups = [];
        layout.pieces.forEach(piece => {
            const dim = `${Math.round(piece.w)}×${Math.round(piece.h)}`;
            const meta = colors[piece.sourceType] || colors[piece.type] || colors.full;
            const name = piece.cutByColumn ? `${meta.name}(기둥 절단)` : meta.name;
            const cutKey = getPieceCutKey(piece);
            const found = groups.find(group => group.name === name && group.dim === dim && group.type === piece.type && group.cutKey === cutKey);
            if (found) found.count += 1;
            else groups.push({ name, dim, type: piece.type, cutKey, count: 1, piece, meta });
        });
        groups.sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.dim.localeCompare(b.dim, 'ko'));
        container.innerHTML = groups.map(group => makeCard(
            group.count,
            makeActualPieceSVG(group.piece, group.meta),
            [{ name: group.name, dim: group.dim }]
        )).join('');
    }

    renderActualPieceCards();
    return;

    const hasCorner      = rem_w > 0 && rem_l > 0;
    const cornerFromCutL = hasCorner && corner_sheets === 0 && cut_l_sheets > 0;
    const cornerFromCutW = hasCorner && corner_sheets === 0 && cut_l_sheets === 0 && cut_w_sheets > 0;

    // ── 온장 ──
    if (full_sheets > 0) {
        container.innerHTML += makeCard(
            full_sheets,
            makeSVG(sw, sl,
                [{x:0, y:0, w:sw, h:sl, fill:'#f8fafc', stroke:'#64748b'}],
                []
            ),
            [{name:'온장', dim:`${sw}×${sl}`}]
        );
    }

    // ── 세로 쪽판 ──
    if (rem_w > 0 && rows_full > 0) {
        const stdSheets = cornerFromCutW ? cut_w_sheets - 1 : cut_w_sheets;

        // 표준 세로 쪽판 카드
        if (stdSheets > 0) {
            container.innerHTML += makeCard(
                stdSheets,
                makeSVG(sw, sl,
                    [{x:0, y:0, w:rem_w, h:sl, fill:'#dbeafe', stroke:'#3b82f6'}],
                    [{dir:'v', pos:rem_w}]
                ),
                [{name:'세로 쪽판', dim:`${rem_w}×${sl}`}]
            );
        }

        // 조합 카드: 세로 쪽판 + 코너 쪽판
        if (cornerFromCutW) {
            const wasteW = sw - rem_w;
            const pieces   = [{x:0, y:0, w:rem_w, h:sl, fill:'#dbeafe', stroke:'#3b82f6'}];
            const cutLines = [{dir:'v', pos:rem_w}];
            if (wasteW > 0) {
                pieces.push({x:rem_w, y:0, w:Math.min(rem_w, wasteW), h:Math.min(rem_l, sl), fill:'#fef3c7', stroke:'#f59e0b'});
                // 수평 절단선: 세로 쪽판 우측 waste 영역에만 (세로 쪽판 침범 안 함)
                if (rem_l < sl) cutLines.push({dir:'h', pos:rem_l, from:rem_w, to:sw});
            }
            container.innerHTML += makeCard(
                1,
                makeSVG(sw, sl, pieces, cutLines),
                [{name:'세로 쪽판', dim:`${rem_w}×${sl}`}, {name:'코너 쪽판', dim:`${rem_w}×${rem_l}`}]
            );
        }
    }

    // ── 가로 쪽판 ──
    if (rem_l > 0 && cols_full > 0) {
        const stdSheets = cornerFromCutL ? cut_l_sheets - 1 : cut_l_sheets;

        // 표준 가로 쪽판 카드
        if (stdSheets > 0) {
            container.innerHTML += makeCard(
                stdSheets,
                makeSVG(sw, sl,
                    [{x:0, y:0, w:sw, h:rem_l, fill:'#dcfce7', stroke:'#22c55e'}],
                    [{dir:'h', pos:rem_l}]
                ),
                [{name:'가로 쪽판', dim:`${sw}×${rem_l}`}]
            );
        }

        // 조합 카드: 가로 쪽판 + 코너 쪽판
        // cut_l_sheets=1이면 stdSheets=0 → 조합 카드만 표시됨
        if (cornerFromCutL) {
            const wasteH   = sl - rem_l;
            const pieces   = [{x:0, y:0, w:sw, h:rem_l, fill:'#dcfce7', stroke:'#22c55e'}];
            const cutLines = [{dir:'h', pos:rem_l}];
            if (wasteH > 0) {
                pieces.push({x:0, y:rem_l, w:rem_w, h:Math.min(rem_l, wasteH), fill:'#fef3c7', stroke:'#f59e0b'});
                // 수직 절단선: 가로 쪽판 아래 waste 영역에만 (가로 쪽판 침범 안 함)
                cutLines.push({dir:'v', pos:rem_w, from:rem_l, to:sl});
            }
            container.innerHTML += makeCard(
                1,
                makeSVG(sw, sl, pieces, cutLines),
                [{name:'가로 쪽판', dim:`${sw}×${rem_l}`}, {name:'코너 쪽판', dim:`${rem_w}×${rem_l}`}]
            );
        }
    }

    // ── 코너 쪽판 (별도 원장 필요) ──
    if (hasCorner && corner_sheets === 1) {
        container.innerHTML += makeCard(
            1,
            makeSVG(sw, sl,
                [{x:0, y:0, w:rem_w, h:rem_l, fill:'#fef3c7', stroke:'#f59e0b'}],
                [{dir:'v', pos:rem_w}, {dir:'h', pos:rem_l}]
            ),
            [{name:'코너 쪽판', dim:`${rem_w}×${rem_l}`}]
        );
    }
}
