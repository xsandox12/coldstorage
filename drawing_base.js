// =============================================================
// drawing_base.js - base-frame mode renderer
// Global deps: ctx, floorDir, columns (defined in drawing_app.html)
// DOM deps: #pipeGap, #gapVal, #pipeW, #pipeH, #base-bom-total, #base-bom-tbody
// =============================================================

function renderBaseMode(w, l, ox, oy, scale, dw, dl) {
    const pipeW = parseInt(document.getElementById('pipeW').value) || 50;
    const pipeH = parseInt(document.getElementById('pipeH').value) || 50;
    const pipeGap = parseInt(document.getElementById('pipeGap').value) || 800;
    const braceGap = parseInt(document.getElementById('braceGap').value) || 3000;
    const zoom = typeof canvasZoom !== 'undefined' ? canvasZoom : 1;
    const stockLen = 6000;

    document.getElementById('gapVal').innerText = pipeGap + 'mm';
    document.getElementById('braceGapVal').innerText = braceGap + 'mm';

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, dw, dl);
    ctx.setLineDash([]);

    function addBom(rows, label, unitLen, count) {
        const len = Math.round(unitLen);
        if (!count || len <= 0) return;
        const found = rows.find(row => row.label === label && row.unitLen === len);
        if (found) found.count += count;
        else rows.push({ label, unitLen: len, count });
    }

    function getBomLabel(label) {
        const labels = {
            '6m Stock': '6m 원자재',
            'Column Connector': '기둥 보강재',
            'Estimated Cuts': '예상 절단수',
            'Estimated Waste': '예상 잔재',
            'Horizontal Border': '가로 외곽재',
            'Horizontal Brace': '가로 보강재',
            'Horizontal Main': '가로 메인재',
            'Vertical Border': '세로 외곽재',
            'Vertical Brace': '세로 보강재',
            'Vertical Main': '세로 메인재'
        };
        return labels[label] || label;
    }

    function drawLabel(cx, cy, text, color = '#475569', rotate = 0) {
        if (typeof drawFixedLabel === 'function') {
            drawFixedLabel(cx, cy, text, { color, bg: 'rgba(255,255,255,0.88)', rotate });
            return;
        }
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.fillRect(cx - tw / 2 - 2, cy - 7, tw + 4, 14);
        ctx.fillStyle = color;
        ctx.fillText(text, cx, cy);
    }

    function drawPipe(rx, ry, rw, rh) {
        if (rw <= 0 || rh <= 0) return;
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx, ry, rw, rh);
    }

    // 길이 라벨 위치: 교차·접합하는 직각 부재를 피해 가장 긴 빈 구간의 가운데 (mm 좌표)
    function getPipeLabelCenter(member, members) {
        const vertical = member.dir === 'v';
        const a1 = vertical ? member.y : member.x;
        const a2 = a1 + (vertical ? member.height : member.width);
        const c1 = vertical ? member.x : member.y;
        const c2 = c1 + (vertical ? member.width : member.height);
        const cuts = members
            .filter(other => other !== member && other.dir !== member.dir)
            .map(other => {
                const oc1 = vertical ? other.x : other.y;
                const oc2 = oc1 + (vertical ? other.width : other.height);
                if (oc2 < c1 - 1 || oc1 > c2 + 1) return null;
                const oa1 = vertical ? other.y : other.x;
                const oa2 = oa1 + (vertical ? other.height : other.width);
                if (oa2 <= a1 || oa1 >= a2) return null;
                return { start: oa1, end: oa2 };
            })
            .filter(Boolean);
        const best = subtractCuts(a1, a2, cuts)
            .reduce((acc, seg) => (!acc || seg.end - seg.start > acc.end - acc.start) ? seg : acc, null)
            || { start: a1, end: a2 };
        const mid = (best.start + best.end) / 2;
        return vertical ? { x: (c1 + c2) / 2, y: mid } : { x: mid, y: (c1 + c2) / 2 };
    }

    // 길이 라벨: 부재 방향으로 회전해서 표시 (부재가 글자보다 길 때만)
    function drawPipeLabel(member, members) {
        const labelTxt = Math.round(memberLength(member)) + 'mm';
        ctx.font = 'bold 9px sans-serif';
        const tw = ctx.measureText(labelTxt).width;
        if (memberLength(member) * scale * zoom <= tw + 6) return;
        const center = getPipeLabelCenter(member, members);
        drawLabel(ox + center.x * scale, oy + center.y * scale, labelTxt, '#475569', member.dir === 'v' ? -Math.PI / 2 : 0);
    }

    function clampColumns() {
        const margin = 25;
        return (typeof columns !== 'undefined' ? columns : [])
            .map(col => ({
                x1: Math.max(0, Math.min(w, col.x - margin)),
                x2: Math.max(0, Math.min(w, col.x + col.width + margin)),
                y1: Math.max(0, Math.min(l, col.y - margin)),
                y2: Math.max(0, Math.min(l, col.y + col.depth + margin))
            }))
            .filter(col => col.x2 > col.x1 && col.y2 > col.y1);
    }

    function rangesOverlap(a1, a2, b1, b2) {
        return Math.min(a2, b2) - Math.max(a1, b1) > 0.5;
    }

    function getEvenPositions(totalSpan, pipeSize, maxGap, anchors = []) {
        const usable = Math.max(0, totalSpan - pipeSize);
        if (usable <= 0) return [0];
        const maxStep = Math.max(1, maxGap);
        const points = [0, usable]
            .concat(anchors)
            .map(v => Math.max(0, Math.min(usable, v)))
            .sort((a, b) => a - b);
        const unique = [];
        points.forEach(point => {
            if (!unique.some(existing => Math.abs(existing - point) < 0.5)) unique.push(point);
        });

        const positions = [unique[0]];
        for (let i = 0; i < unique.length - 1; i++) {
            const start = unique[i];
            const end = unique[i + 1];
            const spanCount = Math.max(1, Math.ceil((end - start) / maxStep));
            const step = (end - start) / spanCount;
            for (let j = 1; j <= spanCount; j++) positions.push(start + step * j);
        }

        return positions.filter((point, index) =>
            index === 0 || Math.abs(point - positions[index - 1]) >= 0.5
        );
    }

    function createMember(label, x, y, width, height, dir) {
        return { label, x, y, width, height, dir };
    }

    function getColumnAnchors(activeColumns, axis, boxOffset, pipeSize, usable) {
        const anchors = [];
        activeColumns.forEach(col => {
            const low = axis === 'x' ? col.x1 : col.y1;
            const high = axis === 'x' ? col.x2 : col.y2;
            anchors.push(low - pipeSize - boxOffset);
            anchors.push(high - boxOffset);
        });
        return anchors.filter(v => v >= 0 && v <= usable);
    }

    function createBaseMembers(activeColumns) {
        const members = [];
        const innerW = Math.max(0, w - 50);
        const innerH = Math.max(0, l - 50);
        const boxX = 25;
        const boxY = 25;
        const rev = typeof floorReversed !== 'undefined' ? floorReversed : false;

        if (innerW <= 0 || innerH <= 0) return members;

        if (floorDir === 'h') {
            const xAnchors = getColumnAnchors(activeColumns, 'x', boxX, pipeW, Math.max(0, innerW - pipeW));
            const xPositions = getEvenPositions(innerW, pipeW, pipeGap, xAnchors);
            // Border: rev=true면 full height, false면 가로재 사이
            // Main: 항상 가로재 사이 (반전과 무관)
            const borderY = rev ? boxY : boxY + pipeH;
            const borderH = rev ? innerH : innerH - 2 * pipeH;
            xPositions.forEach((x, i) => {
                const isEdge = i === 0 || i === xPositions.length - 1;
                if (isEdge) {
                    members.push(createMember('Vertical Border', boxX + x, borderY, pipeW, borderH, 'v'));
                } else {
                    members.push(createMember('Vertical Main', boxX + x, boxY + pipeH, pipeW, innerH - 2 * pipeH, 'v'));
                }
            });

            // rev=false: 가로재 full width / rev=true: 가로재가 세로재 사이에 들어감
            const hX = rev ? boxX + pipeW : boxX;
            const hW = rev ? innerW - 2 * pipeW : innerW;
            members.push(createMember('Horizontal Border', hX, boxY, hW, pipeH, 'h'));
            members.push(createMember('Horizontal Border', hX, boxY + innerH - pipeH, hW, pipeH, 'h'));

            getEvenPositions(innerH, pipeH, braceGap).slice(1, -1).forEach(byOffset => {
                const braceY = boxY + byOffset;
                for (let i = 0; i < xPositions.length - 1; i++) {
                    const xStart = xPositions[i] + pipeW;
                    const xEnd = xPositions[i + 1];
                    const braceLen = xEnd - xStart;
                    if (braceLen > 0) {
                        members.push(createMember('Horizontal Brace', boxX + xStart, braceY, braceLen, pipeH, 'h'));
                    }
                }
            });
        } else {
            const yAnchors = getColumnAnchors(activeColumns, 'y', boxY, pipeH, Math.max(0, innerH - pipeH));
            const yPositions = getEvenPositions(innerH, pipeH, pipeGap, yAnchors);
            // Border: rev=true면 full width, false면 세로재 사이
            // Main: 항상 세로재 사이 (반전과 무관)
            const borderX = rev ? boxX : boxX + pipeW;
            const borderW = rev ? innerW : innerW - 2 * pipeW;
            yPositions.forEach((y, i) => {
                const isEdge = i === 0 || i === yPositions.length - 1;
                if (isEdge) {
                    members.push(createMember('Horizontal Border', borderX, boxY + y, borderW, pipeH, 'h'));
                } else {
                    members.push(createMember('Horizontal Main', boxX + pipeW, boxY + y, innerW - 2 * pipeW, pipeH, 'h'));
                }
            });

            // rev=false: 세로재 full height / rev=true: 세로재가 가로재 사이에 들어감
            const vY = rev ? boxY + pipeH : boxY;
            const vH = rev ? innerH - 2 * pipeH : innerH;
            members.push(createMember('Vertical Border', boxX, vY, pipeW, vH, 'v'));
            members.push(createMember('Vertical Border', boxX + innerW - pipeW, vY, pipeW, vH, 'v'));

            getEvenPositions(innerW, pipeW, braceGap).slice(1, -1).forEach(bxOffset => {
                const braceX = boxX + bxOffset;
                for (let i = 0; i < yPositions.length - 1; i++) {
                    const yStart = yPositions[i] + pipeH;
                    const yEnd = yPositions[i + 1];
                    const braceLen = yEnd - yStart;
                    if (braceLen > 0) {
                        members.push(createMember('Vertical Brace', braceX, boxY + yStart, pipeW, braceLen, 'v'));
                    }
                }
            });
        }

        return members;
    }

    function memberLength(member) {
        return member.dir === 'h' ? member.width : member.height;
    }

    function isPerpendicular(member, dir) {
        return member.dir !== dir;
    }

    function touchesColumn(member, col, side) {
        const x1 = member.x;
        const x2 = member.x + member.width;
        const y1 = member.y;
        const y2 = member.y + member.height;
        if (side === 'left') return Math.abs(x2 - col.x1) < 0.5 && rangesOverlap(y1, y2, col.y1, col.y2);
        if (side === 'right') return Math.abs(x1 - col.x2) < 0.5 && rangesOverlap(y1, y2, col.y1, col.y2);
        if (side === 'top') return Math.abs(y2 - col.y1) < 0.5 && rangesOverlap(x1, x2, col.x1, col.x2);
        return Math.abs(y1 - col.y2) < 0.5 && rangesOverlap(x1, x2, col.x1, col.x2);
    }

    function getNearestMember(members, predicate, distanceFn, minDistance = 0) {
        let best = null;
        members.forEach(member => {
            if (!predicate(member)) return;
            const distance = distanceFn(member);
            if (distance < minDistance - 0.5) return;
            if (!best || distance < best.distance) best = { member, distance };
        });
        return best;
    }

    function addColumnConnectors(members, activeColumns) {
        const connectors = [];
        const minConnector = Math.max(20, Math.min(pipeW, pipeH) / 2);
        const minConnectorPart = Math.max(pipeW, pipeH);

        function subtractMemberOverlaps(connector) {
            if (connector.dir === 'h') {
                const cuts = members
                    .filter(member => member.dir === 'v' && rangesOverlap(connector.y, connector.y + connector.height, member.y, member.y + member.height))
                    .map(member => ({
                        start: Math.max(connector.x, member.x),
                        end: Math.min(connector.x + connector.width, member.x + member.width)
                    }))
                    .filter(cut => cut.end - cut.start > 0.5);

                return subtractCuts(connector.x, connector.x + connector.width, cuts)
                    .filter(seg => seg.end - seg.start >= minConnectorPart)
                    .map(seg => createMember(connector.label, seg.start, connector.y, seg.end - seg.start, connector.height, connector.dir));
            }

            const cuts = members
                .filter(member => member.dir === 'h' && rangesOverlap(connector.x, connector.x + connector.width, member.x, member.x + member.width))
                .map(member => ({
                    start: Math.max(connector.y, member.y),
                    end: Math.min(connector.y + connector.height, member.y + member.height)
                }))
                .filter(cut => cut.end - cut.start > 0.5);

            return subtractCuts(connector.y, connector.y + connector.height, cuts)
                .filter(seg => seg.end - seg.start >= minConnectorPart)
                .map(seg => createMember(connector.label, connector.x, seg.start, connector.width, seg.end - seg.start, connector.dir));
        }

        function pushConnector(connector) {
            subtractMemberOverlaps(connector).forEach(part => connectors.push(part));
        }

        activeColumns.forEach(col => {
            if (floorDir === 'h') {
                const x = col.x1;
                const width = col.x2 - col.x1;
                if (width < minConnector) return;

                const bottomY = col.y2;
                if (bottomY >= 25 && bottomY + pipeH <= l - 25) {
                    pushConnector(createMember('Column Connector', x, bottomY, width, pipeH, 'h'));
                }

                const topY = col.y1 - pipeH;
                if (topY >= 25 && topY + pipeH <= l - 25) {
                    pushConnector(createMember('Column Connector', x, topY, width, pipeH, 'h'));
                }
            } else {
                const y = col.y1;
                const height = col.y2 - col.y1;
                if (height < minConnector) return;

                const leftX = col.x1 - pipeW;
                if (leftX >= 25 && leftX + pipeW <= w - 25) {
                    pushConnector(createMember('Column Connector', leftX, y, pipeW, height, 'v'));
                }

                const rightX = col.x2;
                if (rightX >= 25 && rightX + pipeW <= w - 25) {
                    pushConnector(createMember('Column Connector', rightX, y, pipeW, height, 'v'));
                }
            }
        });

        return members.concat(connectors);
    }

    function mergeMembers(members) {
        const sorted = members.slice().sort((a, b) =>
            a.label.localeCompare(b.label) ||
            a.dir.localeCompare(b.dir) ||
            a.y - b.y ||
            a.x - b.x
        );
        const merged = [];

        sorted.forEach(member => {
            const prev = merged[merged.length - 1];
            if (
                prev &&
                prev.label === member.label &&
                prev.dir === member.dir &&
                Math.abs(prev.x - member.x) < 0.5 &&
                Math.abs(prev.width - member.width) < 0.5 &&
                Math.abs(prev.y + prev.height - member.y) < 0.5 &&
                member.dir === 'v'
            ) {
                prev.height += member.height;
                return;
            }
            if (
                prev &&
                prev.label === member.label &&
                prev.dir === member.dir &&
                Math.abs(prev.y - member.y) < 0.5 &&
                Math.abs(prev.height - member.height) < 0.5 &&
                Math.abs(prev.x + prev.width - member.x) < 0.5 &&
                member.dir === 'h'
            ) {
                prev.width += member.width;
                return;
            }
            merged.push({ ...member });
        });

        return merged;
    }

    function subtractCuts(start, end, cuts) {
        let segments = [{ start, end }];
        cuts.forEach(cut => {
            const next = [];
            segments.forEach(seg => {
                const c1 = Math.max(seg.start, cut.start);
                const c2 = Math.min(seg.end, cut.end);
                if (c2 - c1 <= 0.5) {
                    next.push(seg);
                    return;
                }
                if (c1 - seg.start > 0.5) next.push({ start: seg.start, end: c1 });
                if (seg.end - c2 > 0.5) next.push({ start: c2, end: seg.end });
            });
            segments = next;
        });
        return segments;
    }

    function splitMemberByColumns(member, activeColumns) {
        const x1 = member.x;
        const x2 = member.x + member.width;
        const y1 = member.y;
        const y2 = member.y + member.height;

        if (member.dir === 'h') {
            const cuts = activeColumns
                .filter(col => rangesOverlap(y1, y2, col.y1, col.y2) && rangesOverlap(x1, x2, col.x1, col.x2))
                .map(col => ({ start: Math.max(x1, col.x1), end: Math.min(x2, col.x2) }));

            return subtractCuts(x1, x2, cuts)
                .filter(seg => seg.end - seg.start > 0.5)
                .map(seg => createMember(member.label, seg.start, member.y, seg.end - seg.start, member.height, member.dir));
        }

        const cuts = activeColumns
            .filter(col => rangesOverlap(x1, x2, col.x1, col.x2) && rangesOverlap(y1, y2, col.y1, col.y2))
            .map(col => ({ start: Math.max(y1, col.y1), end: Math.min(y2, col.y2) }));

        return subtractCuts(y1, y2, cuts)
            .filter(seg => seg.end - seg.start > 0.5)
            .map(seg => createMember(member.label, member.x, seg.start, member.width, seg.end - seg.start, member.dir));
    }

    function optimizeStock(parts) {
        const stocks = [];
        const sorted = parts
            .map(part => ({ len: Math.round(part.length), label: part.label || '' }))
            .filter(p => p.len > 0)
            .sort((a, b) => b.len - a.len);

        sorted.forEach(p => {
            let best = null;
            for (let i = 0; i < stocks.length; i++) {
                if (stocks[i].remaining >= p.len && (!best || stocks[i].remaining < stocks[best].remaining)) {
                    best = i;
                }
            }
            if (best === null) stocks.push({ remaining: stockLen - p.len, parts: [p] });
            else {
                stocks[best].remaining -= p.len;
                stocks[best].parts.push(p);
            }
        });

        return {
            stockCount: stocks.length,
            waste: stocks.reduce((sum, stock) => sum + stock.remaining, 0),
            cutCount: stocks.reduce((sum, stock) => sum + stock.parts.length, 0),
            stocks
        };
    }

    function splitLongMembers(members) {
        const result = [];
        members.forEach(member => {
            const len = memberLength(member);
            if (len <= stockLen) {
                result.push(member);
                return;
            }
            const splitCount = Math.ceil(len / stockLen);
            const pieceLen = len / splitCount;

            if (member.dir === 'h') {
                for (let i = 0; i < splitCount; i++) {
                    result.push(createMember(member.label, member.x + i * pieceLen, member.y, pieceLen, member.height, 'h'));
                }
            } else {
                for (let i = 0; i < splitCount; i++) {
                    result.push(createMember(member.label, member.x, member.y + i * pieceLen, member.width, pieceLen, 'v'));
                }
            }
        });
        return result;
    }

    function drawColumns() {
        if (typeof columns === 'undefined') return;
        columns.forEach(col => {
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
            if (cw * zoom > tw + 4 && cd * zoom > 14) {
                drawLabel(cx + cw / 2, cy + cd / 2, labelTxt, '#1e293b');
            }
        });
    }

    function drawDimensions() {
        const dimOffset = 44;
        const x1 = ox + 25 * scale;
        const x2 = ox + (w - 25) * scale;
        const y1 = oy + 25 * scale;
        const y2 = oy + (l - 25) * scale;
        const vx1 = typeof toViewportX === 'function' ? toViewportX(x1) : x1;
        const vx2 = typeof toViewportX === 'function' ? toViewportX(x2) : x2;
        const vy1 = typeof toViewportY === 'function' ? toViewportY(y1) : y1;
        const vy2 = typeof toViewportY === 'function' ? toViewportY(y2) : y2;

        ctx.save();
        if (typeof toViewportX === 'function') resetViewportTransform();
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1;

        const dimY = vy2 + dimOffset;
        ctx.beginPath(); ctx.moveTo(vx1, vy2 + 4); ctx.lineTo(vx1, dimY + 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vx2, vy2 + 4); ctx.lineTo(vx2, dimY + 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vx1, dimY); ctx.lineTo(vx2, dimY); ctx.stroke();
        ctx.fillStyle = '#334155';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('W = ' + Math.round(w - 50).toLocaleString() + ' mm', (vx1 + vx2) / 2, dimY + 3);

        const dimX = vx2 + dimOffset;
        ctx.beginPath(); ctx.moveTo(vx2 + 4, vy1); ctx.lineTo(dimX + 2, vy1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vx2 + 4, vy2); ctx.lineTo(dimX + 2, vy2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dimX, vy1); ctx.lineTo(dimX, vy2); ctx.stroke();
        ctx.translate(dimX + 4, (vy1 + vy2) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('L = ' + Math.round(l - 50).toLocaleString() + ' mm', 0, 0);
        ctx.restore();
    }

    const activeColumns = clampColumns();
    const baseMembers = createBaseMembers(activeColumns);
    const splitMembers = baseMembers.flatMap(member => splitMemberByColumns(member, activeColumns));
    const connectedMembers = addColumnConnectors(splitMembers, activeColumns);
    const mergedMembers = mergeMembers(
        connectedMembers.flatMap(member => splitMemberByColumns(member, activeColumns))
    );
    const finalMembers = splitLongMembers(mergedMembers);
    const bomRows = [];
    let totalL = 0;

    finalMembers.forEach(member => {
        const rx = ox + member.x * scale;
        const ry = oy + member.y * scale;
        const rw = member.width * scale;
        const rh = member.height * scale;
        const len = memberLength(member);
        totalL += len;
        addBom(bomRows, member.label, len, 1);
        drawPipe(rx, ry, rw, rh);
    });
    // 라벨은 모든 파이프를 그린 뒤에 (다음 파이프가 라벨을 덮지 않도록)
    finalMembers.forEach(member => drawPipeLabel(member, finalMembers));

    drawColumns();
    drawDimensions();

    const stockPlan = optimizeStock(finalMembers.map(member => ({ length: memberLength(member), label: member.label })));
    const bomTbody = document.getElementById('base-bom-tbody');
    const bomTotal = document.getElementById('base-bom-total');
    const bomStockCount = document.getElementById('base-bom-stock-count');
    if (bomTbody) {
        const totalPartCount = bomRows.reduce((sum, row) => sum + row.count, 0);
        if (bomTotal) bomTotal.innerText = totalPartCount + '개';
        if (bomStockCount) bomStockCount.innerText = stockPlan.stockCount + '개';
        bomTbody.innerHTML = bomRows
            .sort((a, b) => a.label.localeCompare(b.label) || a.unitLen - b.unitLen)
            .map((row, i) =>
                `<tr style="background:${i % 2 === 0 ? '#f8fafc' : '#ffffff'}">
                    <td style="padding:4px 16px;border-bottom:1px solid #e2e8f0">${getBomLabel(row.label)}</td>
                    <td style="padding:4px 16px;text-align:right;border-bottom:1px solid #e2e8f0">${Math.round(row.unitLen)}</td>
                    <td style="padding:4px 16px;text-align:center;border-bottom:1px solid #e2e8f0">${row.count}</td>
                </tr>`
            )
            .join('');
    }

    const mainCount = document.getElementById('mainCount');
    const mainStat = document.getElementById('mainStat');
    if (mainCount) mainCount.innerText = (totalL / 1000).toFixed(1) + ' m';
    if (mainStat) mainStat.innerText = stockPlan.stockCount + ' pcs (6m)';

    renderPipeCutDiagrams(stockPlan);
}

function renderPipeCutDiagrams(stockPlan) {
    const container = document.getElementById('base-cut-diagrams-container');
    if (!container) return;
    container.innerHTML = '';

    const STOCK_LEN = 6000;
    const MAX_W = 220;
    const BAR_H = 36;

    const TYPE_COLORS = {
        'Horizontal Border': { fill: '#dbeafe', stroke: '#3b82f6', text: '#1d4ed8' },
        'Vertical Border':   { fill: '#dbeafe', stroke: '#3b82f6', text: '#1d4ed8' },
        'Horizontal Main':   { fill: '#dcfce7', stroke: '#22c55e', text: '#15803d' },
        'Vertical Main':     { fill: '#dcfce7', stroke: '#22c55e', text: '#15803d' },
        'Horizontal Brace':  { fill: '#fef3c7', stroke: '#f59e0b', text: '#92400e' },
        'Vertical Brace':    { fill: '#fef3c7', stroke: '#f59e0b', text: '#92400e' },
    };
    const DEFAULT_COLOR = { fill: '#e0f2fe', stroke: '#0ea5e9', text: '#0369a1' };

    // 동일한 파이프 조합의 원장 묶기
    const groups = [];
    stockPlan.stocks.forEach(stock => {
        const key = stock.parts.map(p => p.len).sort((a, b) => b - a).join('|');
        const existing = groups.find(g => g.key === key);
        if (existing) existing.count++;
        else groups.push({ key, count: 1, parts: stock.parts, remaining: stock.remaining });
    });

    function makeBarSVG(parts, remaining) {
        const sc = MAX_W / STOCK_LEN;
        let html = `<rect width="${MAX_W}" height="${BAR_H}" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.5" rx="3"/>`;
        let cursor = 0;
        parts.forEach((p, i) => {
            const pw = Math.round(p.len * sc);
            const px = Math.round(cursor * sc);
            const color = TYPE_COLORS[p.label] || DEFAULT_COLOR;
            html += `<rect x="${px + 1}" y="1" width="${Math.max(pw - 2, 1)}" height="${BAR_H - 2}" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1" rx="2"/>`;
            if (pw > 30) {
                html += `<text x="${px + pw / 2}" y="${BAR_H / 2 + 1}" text-anchor="middle" dominant-baseline="middle" font-size="7.5" font-weight="bold" fill="${color.text}">${p.len}mm</text>`;
            }
            cursor += p.len;
            if (i < parts.length - 1) {
                const cx = Math.round(cursor * sc);
                html += `<line x1="${cx}" y1="0" x2="${cx}" y2="${BAR_H}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3"/>`;
            }
        });
        if (remaining > 0) {
            const cx = Math.round((STOCK_LEN - remaining) * sc);
            const ww = Math.round(remaining * sc);
            html += `<line x1="${cx}" y1="0" x2="${cx}" y2="${BAR_H}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3"/>`;
            if (ww > 22) {
                html += `<text x="${cx + ww / 2}" y="${BAR_H / 2 + 1}" text-anchor="middle" dominant-baseline="middle" font-size="7" fill="#94a3b8">잔재 ${remaining}mm</text>`;
            }
        }
        html += `<text x="${MAX_W / 2}" y="${BAR_H + 11}" text-anchor="middle" font-size="9" fill="#94a3b8">원장 ${STOCK_LEN}mm</text>`;
        return `<svg width="${MAX_W}" height="${BAR_H + 14}" xmlns="http://www.w3.org/2000/svg">${html}</svg>`;
    }

    groups.forEach(g => {
        const partsDesc = g.parts.map(p => p.len + 'mm').join(' + ');
        const card = document.createElement('div');
        card.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px 14px';
        card.innerHTML =
            `<p style="font-size:12px;font-weight:900;color:#3b82f6;margin:0">${g.count}개</p>` +
            makeBarSVG(g.parts, g.remaining) +
            `<p style="font-size:10px;color:#64748b;margin:0;text-align:center">${partsDesc}${g.remaining > 0 ? ' (잔재 ' + g.remaining + 'mm)' : ''}</p>`;
        container.appendChild(card);
    });
}
