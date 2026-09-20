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
    // 칸막이 도어는 벽 번호가 없으므로 첫 외벽 도어 기준
    const firstWallDoor = (typeof doors !== 'undefined') ? doors.find(d => !d.partitionId) : null;
    const doorWall = firstWallDoor ? firstWallDoor.wallIndex : 0;
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
        // 원장 1장당 쪽판 수, 마지막 원장에 남은 공간이 코너 쪽판 이상일 때만 코너를 함께 절단
        const kW = rem_w > 0 ? Math.max(1, Math.floor(sw / rem_w)) : 0;
        const kL = rem_l > 0 ? Math.max(1, Math.floor(sl / rem_l)) : 0;
        const lastCutW = adjustedCutWSheets > 0 ? sourceCounts.cut_w - (adjustedCutWSheets - 1) * kW : 0;
        const lastCutL = adjustedCutLSheets > 0 ? sourceCounts.cut_l - (adjustedCutLSheets - 1) * kL : 0;
        const cornerFitsInCutL = adjustedCutLSheets > 0 && sl - lastCutL * rem_l >= rem_l;
        const cornerFitsInCutW = adjustedCutWSheets > 0 && sw - lastCutW * rem_w >= rem_w;
        const hasCornerPiece = sourceCounts.cut_corner > 0;
        const cornerFromCutL = hasCornerPiece && cornerFitsInCutL;
        const cornerFromCutW = hasCornerPiece && !cornerFitsInCutL && cornerFitsInCutW;
        const adjustedCornerSheets = hasCornerPiece && !cornerFromCutL && !cornerFromCutW ? 1 : 0;
        const adjustedTotalSheets = adjustedFullSheets + adjustedCutWSheets + adjustedCutLSheets + adjustedCornerSheets;
        const bom = buildBomFromPieces(pieces, adjustedTotalSheets);

        return { cols_full, rows_full, rem_w, rem_l,
                 full_sheets: adjustedFullSheets, cut_w_sheets: adjustedCutWSheets,
                 cut_l_sheets: adjustedCutLSheets, corner_sheets: adjustedCornerSheets,
                 cut_w_count: sourceCounts.cut_w, cut_l_count: sourceCounts.cut_l,
                 kW, kL, cornerFromCutW, cornerFromCutL,
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
            full: '원장',
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
        const blockers = [];

        if (typeof columns !== 'undefined') {
            columns.forEach(col => {
                const rect = getExpandedColumnRect(col, roomW, roomL, thickness, gap);
                const b = {
                    type: 'column-expanded',
                    x1: Math.max(0, Math.min(innerW, rect.x1 - thickness - gap)),
                    x2: Math.max(0, Math.min(innerW, rect.x2 - thickness - gap)),
                    y1: Math.max(0, Math.min(innerL, rect.y1 - thickness - gap)),
                    y2: Math.max(0, Math.min(innerL, rect.y2 - thickness - gap))
                };
                if (b.x2 - b.x1 > 0.5 && b.y2 - b.y1 > 0.5) blockers.push(b);
            });
        }

        if (typeof partitions !== 'undefined') {
            partitions.forEach(p => {
                const pDir = p.dir || 'v';
                const pThickness = p.thickness || thickness;
                let b;
                if (pDir === 'v') {
                    // 체크판 내 x = partition.pos - gap, 양쪽 5mm 여유
                    const x1 = Math.max(0, Math.min(innerW, p.pos - 2 * gap));
                    const x2 = Math.max(0, Math.min(innerW, p.pos + pThickness));
                    b = { type: 'partition', x1, x2, y1: 0, y2: innerL };
                } else {
                    const y1 = Math.max(0, Math.min(innerL, p.pos - 2 * gap));
                    const y2 = Math.max(0, Math.min(innerL, p.pos + pThickness));
                    b = { type: 'partition', x1: 0, x2: innerW, y1, y2 };
                }
                if (b.x2 - b.x1 > 0.5 && b.y2 - b.y1 > 0.5) blockers.push(b);
            });
        }

        return blockers;
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
        resetViewportTransform();
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
        { type: 'full',       label: '원장' },
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
// renderCutDiagrams(layout) — 원장 기준 절단 계획 SVG 카드
// 원장 전체를 보여주고 실제 사용 조각 + 절단선을 표시
// ----------------------------------------------------------------
function renderCutDiagrams(layout) {
    const container = document.getElementById('cut-diagrams-container');
    if (!container) return;
    container.innerHTML = '';

    const { sw, sl, rem_w, rem_l, full_sheets, cut_w_sheets, cut_l_sheets, corner_sheets,
            cut_w_count, cut_l_count, kW, kL, cornerFromCutW, cornerFromCutL } = layout;
    const hasCorner = rem_w > 0 && rem_l > 0;

    const MAX_W = 120, MAX_H = 180;
    const WASTE_FILL = '#e2e8f0';
    const WASTE_STROKE = '#cbd5e1';

    // 원장 전체를 배경으로, 사용 조각은 색상으로, 잔재는 회색, 절단선은 빨간 점선
    function makeSheetSVG(pieces, cutLines) {
        const sc = Math.min(MAX_W / sw, MAX_H / sl);
        const W = Math.round(sw * sc), H = Math.round(sl * sc);

        // 잔재 배경 (전체 회색)
        let html = `<rect width="${W}" height="${H}" fill="${WASTE_FILL}" stroke="#94a3b8" stroke-width="1.5"/>`;

        // 사용 조각
        pieces.forEach(p => {
            const px = Math.round(p.x * sc), py = Math.round(p.y * sc);
            const pw = Math.round(p.w * sc), ph = Math.round(p.h * sc);
            html += `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1"/>`;
            // 규격 텍스트
            if (pw > 32 && ph > 18) {
                const dim = `${Math.round(p.w)}×${Math.round(p.h)}`;
                html += `<text x="${px + pw / 2}" y="${py + ph / 2}" text-anchor="middle" dominant-baseline="middle" font-size="8" font-weight="bold" fill="${p.textColor || '#475569'}">${dim}</text>`;
            }
        });

        // 절단선 (빨간 점선)
        cutLines.forEach(cl => {
            if (cl.dir === 'v') {
                const x  = Math.round(cl.pos * sc);
                const y1 = cl.from !== undefined ? Math.round(cl.from * sc) : 0;
                const y2 = cl.to   !== undefined ? Math.round(cl.to   * sc) : H;
                html += `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="5,3"/>`;
            } else {
                const y  = Math.round(cl.pos * sc);
                const x1 = cl.from !== undefined ? Math.round(cl.from * sc) : 0;
                const x2 = cl.to   !== undefined ? Math.round(cl.to   * sc) : W;
                html += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="5,3"/>`;
            }
        });

        // 원장 규격 레이블 (하단)
        html += `<text x="${W / 2}" y="${H + 11}" text-anchor="middle" font-size="9" fill="#94a3b8">원장 ${Math.round(sw)}×${Math.round(sl)}mm</text>`;

        return `<svg width="${W}" height="${H + 14}" xmlns="http://www.w3.org/2000/svg">${html}</svg>`;
    }

    function makeCard(count, svgHtml, pieceName, pieceDim) {
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px 14px">` +
            `<p style="font-size:12px;font-weight:900;color:#3b82f6;margin:0">${count}장</p>` +
            svgHtml +
            `<div style="text-align:center;line-height:1.5">` +
            `<p style="font-size:11px;font-weight:900;color:#1e293b;margin:0">${pieceName}</p>` +
            `<p style="font-size:10px;color:#64748b;margin:0">${pieceDim}mm</p>` +
            `</div></div>`;
    }

    // ── 원장 (절단 없음) ──
    if (full_sheets > 0) {
        container.innerHTML += makeCard(
            full_sheets,
            makeSheetSVG(
                [{x:0, y:0, w:sw, h:sl, fill:'#f8fafc', stroke:'#64748b', textColor:'#475569'}],
                []
            ),
            '원장', `${Math.round(sw)}×${Math.round(sl)}`
        );
    }

    // 원장별 쪽판 수 목록 → 같은 구성끼리 카드 묶기 (마지막 원장에 코너 포함 가능)
    function groupStripSheets(total, sheets, k, withCorner) {
        const groups = [];
        for (let s = 0; s < sheets; s++) {
            const m = s < sheets - 1 ? k : total - (sheets - 1) * k;
            const corner = withCorner && s === sheets - 1;
            const found = groups.find(g => g.m === m && g.corner === corner);
            if (found) found.count += 1;
            else groups.push({ m, corner, count: 1 });
        }
        return groups;
    }

    // ── 세로 쪽판 (수직 절단) ──
    if (rem_w > 0 && cut_w_sheets > 0) {
        groupStripSheets(cut_w_count, cut_w_sheets, kW, cornerFromCutW).forEach(g => {
            const used = g.m * rem_w;
            const pieces = [];
            const cutLines = [];
            for (let i = 0; i < g.m; i++) {
                pieces.push({x:i*rem_w, y:0, w:rem_w, h:sl, fill:'#dbeafe', stroke:'#3b82f6', textColor:'#1d4ed8'});
                if ((i + 1) * rem_w < sw) cutLines.push({dir:'v', pos:(i + 1) * rem_w});
            }
            if (g.corner) {
                pieces.push({x:used, y:0, w:rem_w, h:rem_l, fill:'#fef3c7', stroke:'#f59e0b', textColor:'#92400e'});
                pieces.push({x:used+rem_w, y:0, w:sw-used-rem_w, h:rem_l, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'});
                pieces.push({x:used, y:rem_l, w:sw-used, h:sl-rem_l, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'});
                if (rem_l < sl) cutLines.push({dir:'h', pos:rem_l, from:used, to:sw});
                if (used + rem_w < sw) cutLines.push({dir:'v', pos:used + rem_w, from:0, to:rem_l});
            } else {
                pieces.push({x:used, y:0, w:sw-used, h:sl, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'});
            }
            container.innerHTML += makeCard(
                g.count,
                makeSheetSVG(pieces.filter(p => p.w > 0.5 && p.h > 0.5), cutLines),
                `세로 쪽판 ${g.m}개${g.corner ? ' + 코너 쪽판' : ''}`,
                `${Math.round(rem_w)}×${Math.round(sl)}${g.corner ? ` / ${Math.round(rem_w)}×${Math.round(rem_l)}` : ''}`
            );
        });
    }

    // ── 가로 쪽판 (수평 절단) ──
    if (rem_l > 0 && cut_l_sheets > 0) {
        groupStripSheets(cut_l_count, cut_l_sheets, kL, cornerFromCutL).forEach(g => {
            const used = g.m * rem_l;
            const pieces = [];
            const cutLines = [];
            for (let i = 0; i < g.m; i++) {
                pieces.push({x:0, y:i*rem_l, w:sw, h:rem_l, fill:'#dcfce7', stroke:'#22c55e', textColor:'#15803d'});
                if ((i + 1) * rem_l < sl) cutLines.push({dir:'h', pos:(i + 1) * rem_l});
            }
            if (g.corner) {
                pieces.push({x:0, y:used, w:rem_w, h:rem_l, fill:'#fef3c7', stroke:'#f59e0b', textColor:'#92400e'});
                pieces.push({x:rem_w, y:used, w:sw-rem_w, h:rem_l, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'});
                pieces.push({x:0, y:used+rem_l, w:sw, h:sl-used-rem_l, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'});
                if (rem_w < sw) cutLines.push({dir:'v', pos:rem_w, from:used, to:used + rem_l});
                if (used + rem_l < sl) cutLines.push({dir:'h', pos:used + rem_l});
            } else {
                pieces.push({x:0, y:used, w:sw, h:sl-used, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'});
            }
            container.innerHTML += makeCard(
                g.count,
                makeSheetSVG(pieces.filter(p => p.w > 0.5 && p.h > 0.5), cutLines),
                `가로 쪽판 ${g.m}개${g.corner ? ' + 코너 쪽판' : ''}`,
                `${Math.round(sw)}×${Math.round(rem_l)}${g.corner ? ` / ${Math.round(rem_w)}×${Math.round(rem_l)}` : ''}`
            );
        });
    }

    // ── 코너 쪽판 (별도 원장 필요한 경우) ──
    if (hasCorner && corner_sheets > 0) {
        container.innerHTML += makeCard(
            corner_sheets,
            makeSheetSVG(
                [
                    {x:0,     y:0,     w:rem_w,    h:rem_l,    fill:'#fef3c7', stroke:'#f59e0b', textColor:'#92400e'},
                    {x:rem_w, y:0,     w:sw-rem_w, h:rem_l,    fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'},
                    {x:0,     y:rem_l, w:sw,       h:sl-rem_l, fill:WASTE_FILL, stroke:WASTE_STROKE, textColor:'#94a3b8'}
                ],
                [{dir:'v', pos:rem_w}, {dir:'h', pos:rem_l}]
            ),
            '코너 쪽판', `${Math.round(rem_w)}×${Math.round(rem_l)}`
        );
    }
}
