// =============================================================
// drawing_base.js - base-frame mode renderer
// Global deps: ctx, floorDir, columns (defined in drawing_app.html)
// DOM deps: #pipeGap, #gapVal, #pipeW, #pipeH, #base-bom-total, #base-bom-tbody
// =============================================================

function renderBaseMode(w, l, ox, oy, scale, dw, dl) {
    const pipeW = parseInt(document.getElementById('pipeW').value) || 50;
    const pipeH = parseInt(document.getElementById('pipeH').value) || 50;
    const pipeGap = parseInt(document.getElementById('pipeGap').value) || 700;
    const zoom = typeof canvasZoom !== 'undefined' ? canvasZoom : 1;
    const stockLen = 6000;

    document.getElementById('gapVal').innerText = pipeGap + 'mm';

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

    function drawLabel(cx, cy, text, color = '#475569') {
        if (typeof drawFixedLabel === 'function') {
            drawFixedLabel(cx, cy, text, { color, bg: 'rgba(255,255,255,0.88)' });
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

    function drawPipe(rx, ry, rw, rh, labelTxt) {
        if (rw <= 0 || rh <= 0) return;
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx, ry, rw, rh);

        if (!labelTxt) return;
        ctx.font = 'bold 9px sans-serif';
        const tw = ctx.measureText(labelTxt).width;
        if (rw * zoom > tw + 6 && rh * zoom > 10) {
            drawLabel(rx + rw / 2, ry + rh / 2, labelTxt);
        }
    }

    function clampColumns() {
        return (typeof columns !== 'undefined' ? columns : [])
            .map(col => ({
                x1: Math.max(0, Math.min(w, col.x)),
                x2: Math.max(0, Math.min(w, col.x + col.width)),
                y1: Math.max(0, Math.min(l, col.y)),
                y2: Math.max(0, Math.min(l, col.y + col.depth))
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
        const innerW = Math.max(0, w - pipeW);
        const innerH = Math.max(0, l - pipeH);
        const boxX = pipeW / 2;
        const boxY = pipeH / 2;

        if (innerW <= 0 || innerH <= 0) return members;

        if (floorDir === 'h') {
            const xAnchors = getColumnAnchors(activeColumns, 'x', boxX, pipeW, Math.max(0, innerW - pipeW));
            const xPositions = getEvenPositions(innerW, pipeW, pipeGap, xAnchors);
            xPositions.forEach(x => {
                members.push(createMember('Vertical Main', boxX + x, boxY, pipeW, innerH, 'v'));
            });

            members.push(createMember('Horizontal Border', boxX, boxY, innerW, pipeH, 'h'));
            members.push(createMember('Horizontal Border', boxX, boxY + innerH - pipeH, innerW, pipeH, 'h'));

            if (innerH >= 2000) {
                const braceY = boxY + Math.max(0, (innerH - pipeH) / 2);
                for (let i = 0; i < xPositions.length - 1; i++) {
                    const xStart = xPositions[i] + pipeW;
                    const xEnd = xPositions[i + 1];
                    const braceLen = xEnd - xStart;
                    if (braceLen > 0) {
                        members.push(createMember('Horizontal Brace', boxX + xStart, braceY, braceLen, pipeH, 'h'));
                    }
                }
            }
        } else {
            const yAnchors = getColumnAnchors(activeColumns, 'y', boxY, pipeH, Math.max(0, innerH - pipeH));
            const yPositions = getEvenPositions(innerH, pipeH, pipeGap, yAnchors);
            yPositions.forEach(y => {
                members.push(createMember('Horizontal Main', boxX, boxY + y, innerW, pipeH, 'h'));
            });

            members.push(createMember('Vertical Border', boxX, boxY, pipeW, innerH, 'v'));
            members.push(createMember('Vertical Border', boxX + innerW - pipeW, boxY, pipeW, innerH, 'v'));

            if (innerW >= 2000) {
                const braceX = boxX + Math.max(0, (innerW - pipeW) / 2);
                for (let i = 0; i < yPositions.length - 1; i++) {
                    const yStart = yPositions[i] + pipeH;
                    const yEnd = yPositions[i + 1];
                    const braceLen = yEnd - yStart;
                    if (braceLen > 0) {
                        members.push(createMember('Vertical Brace', braceX, boxY + yStart, pipeW, braceLen, 'v'));
                    }
                }
            }
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
                if (bottomY >= pipeH / 2 && bottomY + pipeH <= l - pipeH / 2) {
                    pushConnector(createMember('Column Connector', x, bottomY, width, pipeH, 'h'));
                }

                const topY = col.y1 - pipeH;
                if (topY >= pipeH / 2 && topY + pipeH <= l - pipeH / 2) {
                    pushConnector(createMember('Column Connector', x, topY, width, pipeH, 'h'));
                }
            } else {
                const y = col.y1;
                const height = col.y2 - col.y1;
                if (height < minConnector) return;

                const leftX = col.x1 - pipeW;
                if (leftX >= pipeW / 2 && leftX + pipeW <= w - pipeW / 2) {
                    pushConnector(createMember('Column Connector', leftX, y, pipeW, height, 'v'));
                }

                const rightX = col.x2;
                if (rightX >= pipeW / 2 && rightX + pipeW <= w - pipeW / 2) {
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
            .map(part => Math.round(part.length))
            .filter(len => len > 0)
            .sort((a, b) => b - a);

        sorted.forEach(len => {
            let best = null;
            for (let i = 0; i < stocks.length; i++) {
                if (stocks[i].remaining >= len && (!best || stocks[i].remaining < stocks[best].remaining)) {
                    best = i;
                }
            }
            if (best === null) stocks.push({ remaining: stockLen - len, parts: [len] });
            else {
                stocks[best].remaining -= len;
                stocks[best].parts.push(len);
            }
        });

        return {
            stockCount: stocks.length,
            waste: stocks.reduce((sum, stock) => sum + stock.remaining, 0),
            cutCount: stocks.reduce((sum, stock) => sum + stock.parts.length, 0)
        };
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
        const x1 = ox + pipeW / 2 * scale;
        const x2 = ox + (w - pipeW / 2) * scale;
        const y1 = oy + pipeH / 2 * scale;
        const y2 = oy + (l - pipeH / 2) * scale;
        const vx1 = typeof toViewportX === 'function' ? toViewportX(x1) : x1;
        const vx2 = typeof toViewportX === 'function' ? toViewportX(x2) : x2;
        const vy1 = typeof toViewportY === 'function' ? toViewportY(y1) : y1;
        const vy2 = typeof toViewportY === 'function' ? toViewportY(y2) : y2;

        ctx.save();
        if (typeof toViewportX === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
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
        ctx.fillText('W = ' + Math.round(w - pipeW).toLocaleString() + ' mm', (vx1 + vx2) / 2, dimY + 3);

        const dimX = vx2 + dimOffset;
        ctx.beginPath(); ctx.moveTo(vx2 + 4, vy1); ctx.lineTo(dimX + 2, vy1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vx2 + 4, vy2); ctx.lineTo(dimX + 2, vy2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dimX, vy1); ctx.lineTo(dimX, vy2); ctx.stroke();
        ctx.translate(dimX + 4, (vy1 + vy2) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('L = ' + Math.round(l - pipeH).toLocaleString() + ' mm', 0, 0);
        ctx.restore();
    }

    const activeColumns = clampColumns();
    const baseMembers = createBaseMembers(activeColumns);
    const splitMembers = baseMembers.flatMap(member => splitMemberByColumns(member, activeColumns));
    const connectedMembers = addColumnConnectors(splitMembers, activeColumns);
    const finalMembers = mergeMembers(
        connectedMembers.flatMap(member => splitMemberByColumns(member, activeColumns))
    );
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
        drawPipe(rx, ry, rw, rh, Math.round(len) + 'mm');
    });

    drawColumns();
    drawDimensions();

    const stockPlan = optimizeStock(finalMembers.map(member => ({ length: memberLength(member) })));
    const bomTbody = document.getElementById('base-bom-tbody');
    const bomTotal = document.getElementById('base-bom-total');
    if (bomTbody && bomTotal) {
        const totalPartCount = bomRows.reduce((sum, row) => sum + row.count, 0);
        bomTotal.innerText = totalPartCount + ' pcs';
        const stockRows = [
            { label: '6m Stock', unitLen: stockLen, count: stockPlan.stockCount },
            { label: 'Estimated Cuts', unitLen: 0, count: stockPlan.cutCount },
            { label: 'Estimated Waste', unitLen: stockPlan.waste, count: 1 }
        ];
        bomTbody.innerHTML = bomRows
            .concat(stockRows)
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
}
