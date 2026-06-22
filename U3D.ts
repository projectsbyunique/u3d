//% color="#7C3AED" weight=100 icon="\uf1b2" block="U3D"
namespace U3D {

    const SKY = 12
    const SHADE_ROW = 1
    const SHADE_FALLBACK = 15
    const FOV = 0.88
    const VPROJ = 25
    const MAX_STEPS = 64
    const WALL_HEIGHT = 8
    const FLOOR_TRANSPARENT_COLOR = 0

    const DEFAULT_SHADER = img`
. 1 2 3 4 5 6 7 8 9 a b c d e f
. d e a e 4 8 6 c 6 9 c f b c f
. b c c c e c 8 f 8 8 f f c f f
. c f f f c f c f c f f f f f f
`

    let cameraX = 16
    let cameraY = 6
    let cameraZ = 16
    let cameraAngleDegrees = 45
    let verticalScale = 1.5
    let texturing = true
    let cameraMovementEnabled = true
    let bakedLightingEnabled = true
    let floorTexturingEnabled = true
    let viewStepOffset = 0
    let heightCollisionThreshold = 999

    let mapWidth = 64
    let mapHeight = 64
    let mapXMask = 63
    let mapZMask = 63
    let mapPow2 = true
    let centerX = 0
    let centerY = 0
    let screenH = 0
    let cachedScreenW = 0
    let depthRows = 0
    let cameraCos = 0
    let cameraSin = 0

    let heightMap: Image = null
    let colorMap: Image = null
    let shader: Image = null
    let floorTex: Image = null
    let tmData: tiles.TileMapData = null
    let tileset: Image[] = null
    let groundedTiles: Image[] = []

    const flatHeightMap: number[] = []

    const flatHeightOverride: number[] = []
    const flatColorMap: number[] = []
    const flatTileMap: number[] = []
    const flatIsCollisionWall: boolean[] = []
    const flatIsGrounded: boolean[] = []
    const flatTextures: number[][] = []
    const floorTextureFlat: number[] = []

    let columnBuf: Buffer = null
    const shadeLUT: number[] = []
    const shadeLUT2: number[] = []
    const colDepth: number[] = []
    const sinLUT: number[] = []
    const cosLUT: number[] = []
    const floorDistLUT: number[] = []
    let floorShadeStart = 0

    let bgImage: Image = null

    //% blockId=u3d_billboardflag
    export enum BillboardFlag {
        //% block="invisible"
        Invisible = 1,
        //% block="ghost (clip walls)"
        Ghost = 2,
        //% block="terrain tracking"
        TerrainTracking = 4
    }

    export class Billboard {
        public lastImg: Image = null
        public followSpeed: number = 0.07
        constructor(
            public spr: Sprite,
            public flatTex: number[],
            public worldY: number,
            public scale: number,
            public vx: number,
            public vz: number,
            public bobAmp: number,
            public bobSpeed: number,
            public bobPhase: number,
            public bobBaseY: number,
            public follows: number,
            public flags: number
        ) { }
    }
    const billboards: Billboard[] = []
    let billboardsDirty = true

    let spinActive = false
    let spinAngle = 0
    let spinCenterX = 0
    let spinCenterZ = 0
    let spinRadius = 10
    let spinSpeed = 0.5

    let wobblePhase = 0
    let isMoving = false

    function init_trig_tables() {
        for (let i = 0; i < 360; i++) {
            const rad = i * 0.0174532925
            sinLUT[i] = Math.sin(rad)
            cosLUT[i] = Math.cos(rad)
        }
    }

    function flatten_image(img: Image): number[] {
        const flat: number[] = []
        const w = img.width, h = img.height
        for (let ty = 0; ty < h; ty++) {
            for (let tx = 0; tx < w; tx++) {
                flat[ty * w + tx] = img.getPixel(tx, ty)
            }
        }
        return flat
    }

    function cache_world_data() {
        if (!heightMap || !colorMap) return

        mapWidth = heightMap.width
        mapHeight = heightMap.height
        mapXMask = mapWidth - 1
        mapZMask = mapHeight - 1

        mapPow2 = (mapWidth & mapXMask) == 0 && (mapHeight & mapZMask) == 0

        if (shader) {
            for (let i = 0; i < 16; i++) {
                const s = shader.getPixel(i, SHADE_ROW)
                shadeLUT[i] = (s == 0 || s == i) ? SHADE_FALLBACK : s
            }

            for (let i = 0; i < 16; i++) {
                shadeLUT2[i] = shadeLUT[shadeLUT[i]]
            }
        }

        if (floorTex) {
            const flat = flatten_image(floorTex)
            for (let i = 0; i < flat.length; i++) floorTextureFlat[i] = flat[i]
        }

        if (tileset) {
            for (let i = 0; i < tileset.length; i++) {
                const tex = tileset[i]
                const flat: number[] = []
                flatIsGrounded[i] = false
                if (tex) {
                    for (let ty = 0; ty < 16; ty++) {
                        for (let tx = 0; tx < 16; tx++) {
                            flat[(ty << 4) | tx] = tex.getPixel(tx, ty)
                        }
                    }
                    for (let gi = 0; gi < groundedTiles.length; gi++) {
                        const g = groundedTiles[gi]
                        if (!g) continue
                        let match = true
                        for (let py = 0; py < 16 && match; py++) {
                            for (let px2 = 0; px2 < 16 && match; px2++) {
                                if (g.getPixel(px2, py) != tex.getPixel(px2, py)) match = false
                            }
                        }
                        if (match) flatIsGrounded[i] = true
                    }
                }
                flatTextures[i] = flat
            }
        }

        for (let z = 0; z < mapHeight; z++) {
            for (let x = 0; x < mapWidth; x++) {
                const idx = z * mapWidth + x
                flatHeightMap[idx] = heightMap.getPixel(x, z)
                flatHeightOverride[idx] = -1
                flatColorMap[idx] = colorMap.getPixel(x, z)
                if (tmData) {
                    flatTileMap[idx] = tmData.getTile(x, z)
                    flatIsCollisionWall[idx] = tmData.isWall(x, z)
                } else {
                    flatTileMap[idx] = 0
                    flatIsCollisionWall[idx] = false
                }
            }
        }
    }

    function terrain_height(wx: number, wz: number): number {
        let cx = (wx | 0) % mapWidth; if (cx < 0) cx += mapWidth
        let cz = (wz | 0) % mapHeight; if (cz < 0) cz += mapHeight
        const idx = cz * mapWidth + cx
        const ov = flatHeightOverride[idx]
        const h = ov >= 0 ? ov : flatHeightMap[idx]
        return h * verticalScale
    }

    function is_wall(wx: number, wz: number): boolean {
        let cx = (wx | 0) % mapWidth; if (cx < 0) cx += mapWidth
        let cz = (wz | 0) % mapHeight; if (cz < 0) cz += mapHeight
        return flatIsCollisionWall[cz * mapWidth + cx]
    }

    function is_hole(wx: number, wz: number): boolean {
        let cx = (wx | 0) % mapWidth; if (cx < 0) cx += mapWidth
        let cz = (wz | 0) % mapHeight; if (cz < 0) cz += mapHeight
        return flatColorMap[cz * mapWidth + cx] == FLOOR_TRANSPARENT_COLOR
    }

    function is_height_wall(wx: number, wz: number): boolean {
        if (heightCollisionThreshold >= 999) return false
        let cx = (wx | 0) % mapWidth; if (cx < 0) cx += mapWidth
        let cz = (wz | 0) % mapHeight; if (cz < 0) cz += mapHeight
        const idx = cz * mapWidth + cx
        const ov = flatHeightOverride[idx]
        const h = ov >= 0 ? ov : flatHeightMap[idx]
        return h > heightCollisionThreshold
    }

    function check_controls() {
        if (!cameraMovementEnabled) return

        cameraAngleDegrees += controller.dx() * 0.8
        if (cameraAngleDegrees < 0) cameraAngleDegrees += 360
        cameraAngleDegrees = cameraAngleDegrees % 360
        const lutIndex = cameraAngleDegrees | 0
        cameraCos = cosLUT[lutIndex]
        cameraSin = sinLUT[lutIndex]

        const moveX = controller.dy() * cameraSin * 0.06
        const moveZ = controller.dy() * cameraCos * 0.06
        const r = 0.2
        const padX = moveX > 0 ? r : -r
        const padZ = moveZ > 0 ? r : -r

        const currentGround = terrain_height(cameraX, cameraZ)
        const blockedX = is_wall(cameraX + moveX + padX, cameraZ) || is_height_wall(cameraX + moveX + padX, cameraZ)
        const blockedZ = is_wall(cameraX, cameraZ + moveZ + padZ) || is_height_wall(cameraX, cameraZ + moveZ + padZ)
        const newX = (moveX != 0 && !blockedX) ? cameraX + moveX : cameraX
        const newZ = (moveZ != 0 && !blockedZ) ? cameraZ + moveZ : cameraZ
        const newGround = terrain_height(newX, newZ)
        if (newGround - currentGround <= 3) {
            if (newGround > currentGround) {
                viewStepOffset -= (newGround - currentGround) * verticalScale
            } else if (newGround < currentGround) {
                viewStepOffset += (currentGround - newGround) * verticalScale
            }
            cameraX = newX
            cameraZ = newZ
            billboardsDirty = true
        }
        viewStepOffset *= 0.75
        if (Math.abs(viewStepOffset) < 0.01) viewStepOffset = 0

        if (cameraX < 0) cameraX += mapWidth
        if (cameraX >= mapWidth) cameraX -= mapWidth
        if (cameraZ < 0) cameraZ += mapHeight
        if (cameraZ >= mapHeight) cameraZ -= mapHeight

        if (controller.A.isPressed()) cameraY += 0.1
        if (controller.B.isPressed()) cameraY -= 0.1
        if (cameraY < 1) cameraY = 1

        isMoving = controller.dy() != 0
        if (isMoving) wobblePhase += 0.20
    }

    function mode_7() {
        const bg = bgImage
        const sw = cachedScreenW
        const cosv = cameraCos
        const sinv = cameraSin
        const camX = cameraX
        const camZ = cameraZ
        const wobble = isMoving ? Math.sin(wobblePhase) * 0.4 : 0
        const camY = cameraY + terrain_height(cameraX, cameraZ) + wobble + viewStepOffset
        const mw = mapWidth
        const mh = mapHeight
        const vScale = verticalScale
        const col = columnBuf
        const hasFloorTex = floorTexturingEnabled && floorTextureFlat.length > 0
        const camYVP = camY * VPROJ

        const maxRow = screenH - centerY
        for (let k = 1; k <= maxRow; k++) floorDistLUT[k] = camYVP / k

        floorShadeStart = bakedLightingEnabled ? ((camYVP / 12) | 0) + 1 : 0

        const dirX = -sinv, dirZ = -cosv
        const planeX = -cosv * FOV, planeZ = sinv * FOV
        const invSw = 2 / sw
        const rayXBase = dirX - planeX
        const rayZBase = dirZ - planeZ
        const rayXStep = planeX * invSw
        const rayZStep = planeZ * invSw

        let rayXLinear = rayXBase
        let rayZLinear = rayZBase
        for (let x = 0; x < sw; x++) {
            col.fill(SKY, 0, centerY)
            col.fill(11, centerY, screenH - centerY)

            let rayX = rayXLinear
            let rayZ = rayZLinear
            rayXLinear += rayXStep
            rayZLinear += rayZStep
            if (rayX == 0) rayX = 0.0001
            if (rayZ == 0) rayZ = 0.0001

            let watermark = screenH
            let firstBand = true
            let lastDist = MAX_STEPS * 2

            const rxInv = 1 / rayX, rzInv = 1 / rayZ
            const deltaX = rxInv < 0 ? -rxInv : rxInv
            const deltaZ = rzInv < 0 ? -rzInv : rzInv

            let mapX = camX | 0, mapZ = camZ | 0
            const stepX = rayX < 0 ? -1 : 1
            const stepZ = rayZ < 0 ? -1 : 1
            let sideDistX = (rayX < 0 ? (camX - mapX) : (mapX + 1 - camX)) * deltaX
            let sideDistZ = (rayZ < 0 ? (camZ - mapZ) : (mapZ + 1 - camZ)) * deltaZ

            for (let s = 0; s < MAX_STEPS; s++) {
                let dist = 0, side = 0
                if (sideDistX < sideDistZ) {
                    dist = sideDistX; sideDistX += deltaX; mapX += stepX; side = 0
                } else {
                    dist = sideDistZ; sideDistZ += deltaZ; mapZ += stepZ; side = 1
                }
                if (dist < 0.1) continue
                const nextDist = sideDistX < sideDistZ ? sideDistX : sideDistZ

                const perpNear = side == 0
                    ? (mapX - camX + (1 - stepX) / 2) / rayX
                    : (mapZ - camZ + (1 - stepZ) / 2) / rayZ
                const useDist = perpNear > 0.1 ? perpNear : 0.1
                const perpRatio = useDist / dist
                const nextPerp = nextDist * perpRatio

                const cx = mapPow2 ? (mapX & mapXMask) : (((mapX % mw) + mw) % mw)
                const cz = mapPow2 ? (mapZ & mapZMask) : (((mapZ % mh) + mh) % mh)
                const mapIdx = cz * mw + cx

                const ov = flatHeightOverride[mapIdx]
                const rawH = ov >= 0 ? ov : flatHeightMap[mapIdx]
                const rawC = flatColorMap[mapIdx]

                const isHole = rawC == FLOOR_TRANSPARENT_COLOR
                const invNextPerpEarly = 1 / nextPerp
                if (isHole && !flatTileMap[mapIdx]) {
                    if (hasFloorTex && watermark > 0) {
                        let hFar = (centerY + camYVP * invNextPerpEarly) | 0
                        if (hFar < 0) hFar = 0
                        if (hFar >= screenH) hFar = screenH - 1
                        if (hFar < watermark) {

                            let shadeBoundary = centerY + floorShadeStart
                            if (shadeBoundary < hFar) shadeBoundary = hFar
                            if (shadeBoundary > watermark) shadeBoundary = watermark
                            const unshadeEnd = shadeBoundary

                            for (let y = hFar; y < unshadeEnd; y++) {
                                const fd = floorDistLUT[y - centerY]
                                const fTexX = (((camX + rayX * fd) * 16) | 0) & 15
                                const fTexY = (((camZ + rayZ * fd) * 16) | 0) & 15
                                col[y] = shadeLUT[floorTextureFlat[(fTexY << 4) | fTexX]]
                            }

                            for (let y = unshadeEnd; y < watermark; y++) {
                                const fd = floorDistLUT[y - centerY]
                                const fTexX = (((camX + rayX * fd) * 16) | 0) & 15
                                const fTexY = (((camZ + rayZ * fd) * 16) | 0) & 15
                                col[y] = floorTextureFlat[(fTexY << 4) | fTexX]
                            }
                            watermark = hFar
                        }
                    }
                    firstBand = false
                    continue
                }

                const tileIdx = flatTileMap[mapIdx]
                let h = rawH
                const hasTile = tileIdx != 0
                if (hasTile && flatIsGrounded[tileIdx]) h += WALL_HEIGHT

                const ht = (camY - h * vScale) * VPROJ

                const invUseDist = 1 / useDist

                let top = (centerY + ht * invUseDist) | 0
                let topFar = (centerY + ht * invNextPerpEarly) | 0
                if (top < 0) top = 0
                if (topFar < 0) topFar = 0
                if (topFar > top) topFar = top

                const c = rawC
                const topColor = bakedLightingEnabled ? shadeLUT[c] : c
                let faceColor = c
                if (side == 1 && bakedLightingEnabled) faceColor = (x & 1) ? shadeLUT[c] : c

                if (top < watermark) {
                    if (texturing && !firstBand && hasTile && flatTextures[tileIdx] && flatTextures[tileIdx].length > 0) {
                        let wallX = side == 0 ? camZ + useDist * rayZ : camX + useDist * rayX

                        const wallFloor = wallX < 0 ? (wallX | 0) - 1 : (wallX | 0)
                        wallX -= wallFloor
                        let texX = (wallX * 16) | 0
                        if (texX >= 16) texX = 15

                        const topU = centerY + ht * invUseDist
                        const baseU = centerY + camYVP * invUseDist
                        const fullSpan = baseU - topU
                        if (fullSpan > 0) {
                            const stepPerRow = (16 << 8) / fullSpan
                            let accum = ((top - topU) * stepPerRow) | 0
                            if (accum < 0) accum = 0
                            const cachedTex = flatTextures[tileIdx]
                            const shadeFull = bakedLightingEnabled && useDist > 12
                            const shadeDither = bakedLightingEnabled && useDist > 6 && dist <= 12
                            const useShade = shadeFull || (shadeDither && (x & 1) === 0)
                            for (let y = top; y < watermark; y++) {
                                let texY = accum >> 8
                                if (texY >= 16) texY = 15
                                let px = cachedTex[(texY << 4) | texX]
                                if (px) {
                                    if (useShade) px = shadeLUT[px]
                                    if (side == 1 && (x & 1) === 0) px = shadeLUT[px]
                                    col[y] = px
                                }
                                accum += stepPerRow
                            }
                        }
                    } else {
                        col.fill(firstBand ? topColor : faceColor, top, watermark - top)
                    }
                    watermark = top
                }
                if (topFar < watermark) {
                    col.fill(topColor, topFar, watermark - topFar)
                    watermark = topFar
                }
                firstBand = false
                if (watermark <= 0) { lastDist = dist; break }
                lastDist = dist
            }

            colDepth[x] = lastDist
            bg.setRows(x, col)
        }

        draw_billboards(bg, sw, sinv, cosv, camX, camZ, camY)
    }

    function draw_billboards(bg: Image, sw: number, sinv: number, cosv: number, camX: number, camZ: number, camY: number) {
        const dirX = -sinv, dirZ = -cosv
        const planeX = -cosv * FOV, planeZ = sinv * FOV
        const invDet = 1 / (planeX * dirZ - dirX * planeZ)

        if (billboardsDirty) {
            billboards.sort((a, b) => {
                const dxA = (a.spr.x / 16) - camX, dzA = (a.spr.y / 16) - camZ
                const dxB = (b.spr.x / 16) - camX, dzB = (b.spr.y / 16) - camZ
                return (dxB * dxB + dzB * dzB) - (dxA * dxA + dzA * dzA)
            })
            billboardsDirty = false
        }

        const bbCount = billboards.length
        for (let bbi = 0; bbi < bbCount; bbi++) {
            const bb = billboards[bbi]
            if (bb.flags & 1) continue
            const bx = bb.spr.x / 16, bz = bb.spr.y / 16, by = bb.worldY
            const relX = bx - camX, relZ = bz - camZ
            const tX = invDet * (dirZ * relX - dirX * relZ)
            const tY = invDet * (-planeZ * relX + planeX * relZ)
            if (tY <= 0.1) continue

            const img = bb.spr.image
            const imgW = img.width, imgH = img.height

            if (img !== bb.lastImg) {
                bb.lastImg = img
                const newFlat: number[] = []
                for (let fy = 0; fy < imgH; fy++)
                    for (let fx = 0; fx < imgW; fx++)
                        newFlat[fy * imgW + fx] = img.getPixel(fx, fy)
                bb.flatTex = newFlat
            }
            const flat = bb.flatTex

            const screenXc = (sw / 2) * (1 + tX / tY)
            const sizeH = (VPROJ * bb.scale / tY) | 0
            const sizeW = (sizeH * imgW / imgH) | 0
            if (sizeW <= 0 || sizeH <= 0) continue

            const drawTop = (centerY + (camY - by) * VPROJ / tY) | 0
            const x0 = (screenXc - sizeW / 2) | 0
            const shadeSprite = bakedLightingEnabled && tY > 8
            const shadeAll = tY > 14

            const yStart = drawTop < 0 ? 0 : drawTop
            const yEnd = (drawTop + sizeH) > screenH ? screenH : (drawTop + sizeH)
            if (yStart >= yEnd) continue

            const texYStep = (imgH << 8) / sizeH
            const texYInit = ((yStart - drawTop) * texYStep) | 0

            const texXStep = (imgW << 8) / sizeW

            for (let sx = 0; sx < sizeW; sx++) {
                const screenX = x0 + sx
                if (screenX < 0 || screenX >= sw) continue
                if (colDepth[screenX] < tY) continue

                const texX = (sx * texXStep >> 8)
                const texXClamped = texX < imgW ? texX : imgW - 1
                const dither = shadeSprite && !shadeAll && (screenX & 1) === 0

                let texYAcc = texYInit
                for (let screenY = yStart; screenY < yEnd; screenY++) {
                    const texY = texYAcc >> 8
                    const texYClamped = texY < imgH ? texY : imgH - 1
                    let px = flat[texYClamped * imgW + texXClamped]
                    if (px != 0) {
                        if (shadeAll) {
                            px = shadeLUT[px]
                        } else if (dither) {
                            px = shadeLUT[px]
                        }
                        bg.setPixel(screenX, screenY, px)
                    }
                    texYAcc += texYStep
                }
            }
        }
    }

    const FF_DX = [1, -1, 0, 0]
    const FF_DZ = [0, 0, 1, -1]
    const flowDir: number[] = []
    const ffQueue: number[] = []
    let ffCamCellX = -1
    let ffCamCellZ = -1

    function ff_passable(x: number, z: number): number {
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return 0
        const idx = z * mapWidth + x
        if (flatIsCollisionWall[idx]) return 0
        if (flatColorMap[idx] == FLOOR_TRANSPARENT_COLOR) return 0
        return 1
    }

    function ff_bake(gx: number, gz: number) {
        const total = mapWidth * mapHeight
        for (let i = 0; i < total; i++) flowDir[i] = 255

        let head = 0, tail = 0
        const goalIdx = gz * mapWidth + gx
        flowDir[goalIdx] = 4
        ffQueue[tail++] = goalIdx

        while (head < tail) {
            const cur = ffQueue[head++]
            const cx2 = cur % mapWidth
            const cz2 = (cur / mapWidth) | 0
            for (let d = 0; d < 4; d++) {
                const nx = cx2 + FF_DX[d], nz = cz2 + FF_DZ[d]
                if (!ff_passable(nx, nz)) continue
                const ni = nz * mapWidth + nx
                if (flowDir[ni] != 255) continue
                flowDir[ni] = d ^ 1
                ffQueue[tail++] = ni
            }
        }
    }

    function ff_los(x1: number, z1: number, x2: number, z2: number): number {
        const dx = x2 - x1, dz = z2 - z1
        const steps = Math.ceil(Math.sqrt(dx * dx + dz * dz) * 2)
        if (steps == 0) return 1
        const sx = dx / steps, sz = dz / steps
        let px = x1, pz = z1
        for (let i = 0; i < steps; i++) {
            px += sx; pz += sz
            const cx = px | 0, cz = pz | 0
            if (cx < 0 || cx >= mapWidth || cz < 0 || cz >= mapHeight) return 0
            const idx = cz * mapWidth + cx
            if (flatIsCollisionWall[idx]) return 0
            if (flatColorMap[idx] == FLOOR_TRANSPARENT_COLOR) return 0
        }
        return 1
    }

    function ff_steer(bb: Billboard, speed: number) {
        const wx = bb.spr.x / 16, wz = bb.spr.y / 16

        let dx = 0, dz = 0
        if (ff_los(wx, wz, cameraX, cameraZ)) {
            dx = cameraX - wx
            dz = cameraZ - wz
        } else {

            const cx = wx | 0, cz = wz | 0
            const idx = cz * mapWidth + cx
            const dir = flowDir[idx]
            if (dir == 255 || dir == 4) {

                bb.vx *= 0.85
                bb.vz *= 0.85
                return
            }
            const tx = cx + FF_DX[dir]
            const tz = cz + FF_DZ[dir]
            dx = (tx + 0.5) - wx
            dz = (tz + 0.5) - wz
        }

        const d = Math.sqrt(dx * dx + dz * dz)
        if (d > 0.01) {

            const targetVx = (dx / d) * speed
            const targetVz = (dz / d) * speed
            bb.vx = bb.vx * 0.6 + targetVx * 0.4
            bb.vz = bb.vz * 0.6 + targetVz * 0.4
        }
    }

    function update_billboards() {
        const camCellX = cameraX | 0
        const camCellZ = cameraZ | 0
        if (camCellX != ffCamCellX || camCellZ != ffCamCellZ) {
            ffCamCellX = camCellX
            ffCamCellZ = camCellZ
            ff_bake(camCellX, camCellZ)
        }

        const bbCount = billboards.length
        for (let bbi = 0; bbi < bbCount; bbi++) {
            const bb = billboards[bbi]
            const hasBob = bb.bobAmp > 0
            const hasMotion = bb.vx != 0 || bb.vz != 0
            if (!hasBob && !hasMotion && !bb.follows) continue

            let cx = bb.spr.x / 16
            let cz = bb.spr.y / 16

            if (bb.follows) {
                const toCamX = cameraX - cx
                const toCamZ = cameraZ - cz
                const toCamDist = Math.sqrt(toCamX * toCamX + toCamZ * toCamZ)
                if (toCamDist > 1.5) {
                    const speed = bb.followSpeed
                    if (bb.flags & 2) {

                        const tvx = (toCamX / toCamDist) * speed
                        const tvz = (toCamZ / toCamDist) * speed
                        bb.vx = bb.vx * 0.6 + tvx * 0.4
                        bb.vz = bb.vz * 0.6 + tvz * 0.4
                    } else {
                        ff_steer(bb, speed)
                    }
                } else {
                    bb.vx *= 0.85
                    bb.vz *= 0.85
                }
            }

            const r = 0.3
            const isGhost = (bb.flags & 2) != 0

            const curCellX = mapPow2 ? ((cx | 0) & mapXMask) : (((cx | 0) % mapWidth + mapWidth) % mapWidth)
            const curCellZ = mapPow2 ? ((cz | 0) & mapZMask) : (((cz | 0) % mapHeight + mapHeight) % mapHeight)
            const inHoleNow = flatColorMap[curCellZ * mapWidth + curCellX] == FLOOR_TRANSPARENT_COLOR

            if (!isGhost) {
                const padX = bb.vx > 0 ? r : -r
                const checkX = (cx + bb.vx + padX) | 0
                const cellX = mapPow2 ? (checkX & mapXMask) : (((checkX % mapWidth) + mapWidth) % mapWidth)
                const idx = curCellZ * mapWidth + cellX
                let blockedX = flatIsCollisionWall[idx]
                if (!blockedX && bb.follows && !inHoleNow && flatColorMap[idx] == FLOOR_TRANSPARENT_COLOR) blockedX = true
                if (blockedX) {
                    if (bb.follows) bb.vx = 0
                    else bb.vx = -bb.vx
                } else {
                    cx = cx + bb.vx
                }
            } else {
                cx = cx + bb.vx
            }

            if (!isGhost) {
                const newCellX = mapPow2 ? ((cx | 0) & mapXMask) : (((cx | 0) % mapWidth + mapWidth) % mapWidth)
                const padZ = bb.vz > 0 ? r : -r
                const checkZ = (cz + bb.vz + padZ) | 0
                const cellZ = mapPow2 ? (checkZ & mapZMask) : (((checkZ % mapHeight) + mapHeight) % mapHeight)
                const idx = cellZ * mapWidth + newCellX
                let blockedZ = flatIsCollisionWall[idx]
                if (!blockedZ && bb.follows && !inHoleNow && flatColorMap[idx] == FLOOR_TRANSPARENT_COLOR) blockedZ = true
                if (blockedZ) {
                    if (bb.follows) bb.vz = 0
                    else bb.vz = -bb.vz
                } else {
                    cz = cz + bb.vz
                }
            } else {
                cz = cz + bb.vz
            }

            bb.spr.x = cx * 16
            bb.spr.y = cz * 16

            let bobOffset = 0
            if (hasBob) {
                bb.bobPhase += bb.bobSpeed
                bobOffset = Math.sin(bb.bobPhase) * bb.bobAmp
            }
            const terrainOffset = (bb.flags & 4) ? terrain_height(cx, cz) : 0
            bb.worldY = bb.bobBaseY + bobOffset + terrainOffset

            billboardsDirty = true
        }
    }

    /**
     * Set the maps and assets the engine renders from.
     * Call this BEFORE U3D.start().
     * @param height heightmap image (pixel brightness = terrain height)
     * @param color colormap image (pixel color = terrain color, transparent = hole)
     * @param shaderImg shader palette image (row 1 is the dim-color lookup)
     * @param floor floor/lava texture for transparent cells
     * @param tilemap tilemap data for walls and wall textures
     */
    //% blockId=u3d_setmaps block="U3D set maps: height %height color %color floor %floor tilemap %tilemap || shader %shaderImg"
    //% height.shadow=screen_image_picker color.shadow=screen_image_picker
    //% floor.shadow=screen_image_picker shaderImg.shadow=screen_image_picker
    //% expandableArgumentMode="toggle"
    //% group="Setup" weight=100
    export function setMaps(height: Image, color: Image, floor: Image, tilemap: tiles.TileMapData, shaderImg: Image = null) {
        heightMap = height
        colorMap = color
        shader = shaderImg ? shaderImg : DEFAULT_SHADER
        floorTex = floor

        tiles.setTilemap(tilemap)
        const sc = game.currentScene()
        if (sc.tileMap && sc.tileMap.renderable) {
            sc.allSprites.removeElement(sc.tileMap.renderable)
        }
        tmData = tilemap
        tileset = tilemap.getTileset()
    }

    /**
     * Set which tile textures count as "grounded walls" (stack on top of terrain).
     * Pass an array of tile images.
     */
    //% blockId=u3d_setgrounded block="U3D set grounded wall tiles to %tiles"
    //% group="Setup" weight=90
    export function setGroundedTiles(tiles: Image[]) {
        groundedTiles = tiles
    }

    /**
     * Start the engine. Call AFTER setMaps().
     * Sets up the render loop, controls, and frame pacing.
     */
    //% blockId=u3d_start block="U3D start engine"
    //% group="Setup" weight=80
    export function start() {
        cachedScreenW = scene.screenWidth()
        centerX = cachedScreenW * 0.5
        centerY = scene.screenHeight() * 0.5
        screenH = scene.screenHeight()
        depthRows = centerY - 1
        columnBuf = control.createBuffer(screenH)

        bgImage = scene.backgroundImage()

        init_trig_tables()
        cache_world_data()

        const initialLutIndex = cameraAngleDegrees | 0
        cameraCos = cosLUT[initialLutIndex]
        cameraSin = sinLUT[initialLutIndex]

        let frameCount = 0
        game.onUpdate(function () {
            frameCount++

            if (spinActive) {
                spinAngle = (spinAngle + spinSpeed) % 360
                const idx = spinAngle | 0
                cameraX = spinCenterX + sinLUT[idx] * spinRadius
                cameraZ = spinCenterZ + cosLUT[idx] * spinRadius
                cameraAngleDegrees = spinAngle % 360
                const li = cameraAngleDegrees | 0
                cameraCos = cosLUT[li]
                cameraSin = sinLUT[li]
                update_billboards()
                mode_7()
                return
            }

            update_billboards()
            const hasDpad = controller.dx() != 0 || controller.dy() != 0
            const hasButton = controller.A.isPressed() || controller.B.isPressed()
            if (hasDpad || hasButton) {
                check_controls()
                mode_7()
            } else if (frameCount % 2 == 0) {
                const li = cameraAngleDegrees | 0
                cameraCos = cosLUT[li]
                cameraSin = sinLUT[li]
                mode_7()
            }
        })
    }

    /**
     * Add a billboard sprite to the world.
     * @param spr the Sprite to render as a billboard
     * @param worldX X position in world tiles
     * @param worldZ Z position in world tiles
     * @param worldY vertical height in world units
     * @param scale render scale (1 = normal, 4 = big)
     * @param vx initial X velocity (0 for static)
     * @param vz initial Z velocity (0 for static)
     * @param bobAmp vertical bob amplitude (0 = no bob)
     * @param bobSpeed bob speed in radians per frame
     */
    //% blockId=u3d_addbillboard block="U3D add billboard %spr at x %worldX z %worldZ y %worldY scale %scale || vx %vx vz %vz bob %bobAmp bobSpeed %bobSpeed"
    //% expandableArgumentMode="toggle"
    //% scale.defl=1 vx.defl=0 vz.defl=0 bobAmp.defl=0 bobSpeed.defl=0
    //% group="Billboards" weight=100
    export function addBillboard(spr: Sprite, worldX: number, worldZ: number, worldY: number, scale: number,
                                  vx: number = 0, vz: number = 0, bobAmp: number = 0, bobSpeed: number = 0) {
        spr.setFlag(SpriteFlag.Invisible, true)
        spr.x = worldX * 16
        spr.y = worldZ * 16
        const flat = flatten_image(spr.image)
        billboards.push(new Billboard(spr, flat, worldY, scale, vx, vz, bobAmp, bobSpeed, 0, worldY, 0, 0))
        billboardsDirty = true
    }

    /**
     * Make a billboard follow the camera using flow-field pathfinding.
     * @param spr the sprite to set
     * @param on true to enable, false to disable
     * @param speed how fast it chases (world units per frame). Default 0.07
     *              (player walks at ~0.06, so default just barely keeps up).
     *              Try 0.1 for an aggressive chase, 0.03 for slow lumbering.
     */
    //% blockId=u3d_setfollows block="U3D set %spr follows player %on || speed %speed"
    //% on.defl=true speed.defl=0.07
    //% expandableArgumentMode="toggle"
    //% group="Billboards" weight=90
    export function setFollows(spr: Sprite, on: boolean, speed: number = 0.07) {
        for (let _bbi = 0; _bbi < billboards.length; _bbi++) { const bb = billboards[_bbi]
            if (bb.spr == spr) {
                bb.follows = on ? 1 : 0
                bb.followSpeed = speed
                if (on && bb.vx == 0 && bb.vz == 0) {
                    bb.vx = speed
                    bb.vz = speed * 0.7
                }
                return
            }
        }
    }

    /**
     * Toggle a flag on a billboard. Flags can be combined freely.
     * - Invisible: stops rendering but physics still update
     * - Ghost: clips through walls and holes; followers steer straight at player
     * - TerrainTracking: worldY follows the terrain elevation under the sprite
     * @param spr the sprite to modify
     * @param flag which flag to toggle
     * @param on true to set, false to clear
     */
    //% blockId=u3d_setbillboardflag block="U3D set %spr flag %flag to %on"
    //% on.defl=true
    //% group="Billboards" weight=80
    export function setBillboardFlag(spr: Sprite, flag: BillboardFlag, on: boolean) {
        for (let _bbi = 0; _bbi < billboards.length; _bbi++) { const bb = billboards[_bbi]
            if (bb.spr == spr) {
                if (on) bb.flags = bb.flags | flag
                else bb.flags = bb.flags & ~flag
                return
            }
        }
    }

    /**
     * Check whether a flag is set on a billboard.
     */
    //% blockId=u3d_getbillboardflag block="U3D %spr has flag %flag"
    //% group="Billboards" weight=70
    export function billboardHasFlag(spr: Sprite, flag: BillboardFlag): boolean {
        for (let _bbi = 0; _bbi < billboards.length; _bbi++) { const bb = billboards[_bbi]
            if (bb.spr == spr) return (bb.flags & flag) != 0
        }
        return false
    }

    /**
     * Spin the camera around a world position. Disables manual controls
     * until U3D.endSpin() is called. Useful for title screens, cutscenes,
     * boss reveals, or any cinematic moment.
     * @param worldX X center of orbit (world tiles)
     * @param worldZ Z center of orbit (world tiles)
     * @param radius distance from center
     * @param speed degrees per frame
     */
    //% blockId=u3d_spinaround block="U3D spin camera around x %worldX z %worldZ radius %radius speed %speed"
    //% radius.defl=10 speed.defl=0.5
    //% group="Camera" weight=90
    export function spinAround(worldX: number, worldZ: number, radius: number, speed: number) {
        spinActive = true
        spinCenterX = worldX
        spinCenterZ = worldZ
        spinRadius = radius
        spinSpeed = speed
        spinAngle = 0
        cameraMovementEnabled = false
    }

    /**
     * Stop the spin and return camera to player control.
     */
    //% blockId=u3d_endspin block="U3D end spin"
    //% group="Camera" weight=80
    export function endSpin() {
        spinActive = false
        cameraMovementEnabled = true
    }

    /**
     * Move the camera instantly to a world position.
     */
    //% blockId=u3d_setcamera block="U3D set camera to x %worldX z %worldZ y %worldY facing %angle"
    //% group="Camera" weight=100
    export function setCamera(worldX: number, worldZ: number, worldY: number, angle: number) {
        cameraX = worldX
        cameraZ = worldZ
        cameraY = worldY
        cameraAngleDegrees = angle % 360
        if (cameraAngleDegrees < 0) cameraAngleDegrees += 360
        const li = cameraAngleDegrees | 0
        cameraCos = cosLUT[li]
        cameraSin = sinLUT[li]
    }

    /**
     * Get the camera's current X position in world tiles.
     */
    //% blockId=u3d_getcamerax block="U3D camera x"
    //% group="Camera" weight=70
    export function getCameraX(): number { return cameraX }

    /**
     * Get the camera's current Z position in world tiles.
     */
    //% blockId=u3d_getcameraz block="U3D camera z"
    //% group="Camera" weight=60
    export function getCameraZ(): number { return cameraZ }

    /**
     * Get the camera's current Y (height) above the terrain.
     */
    //% blockId=u3d_getcameray block="U3D camera y"
    //% group="Camera" weight=50
    export function getCameraY(): number { return cameraY + terrain_height(cameraX, cameraZ) }

    /**
     * Toggle wall texturing on or off.
     */
    //% blockId=u3d_settexturing block="U3D set wall texturing %on"
    //% group="Settings" weight=100
    export function setTexturing(on: boolean) { texturing = on }

    /**
     * Toggle distance shading (baked lighting) on or off.
     */
    //% blockId=u3d_setlighting block="U3D set distance shading %on"
    //% group="Settings" weight=90
    export function setLighting(on: boolean) { bakedLightingEnabled = on }

    /**
     * Set how much terrain height varies — 1.0 is flat, higher is more dramatic.
     */
    //% blockId=u3d_setverticalscale block="U3D set vertical scale to %scale"
    //% scale.defl=1.5
    //% group="Settings" weight=80
    export function setVerticalScale(scale: number) { verticalScale = scale }

    /**
     * Override the height of a specific tile, in heightmap units (the same
     * 0–16ish scale as the heightmap pixels). Accepts decimals so you can
     * animate doors smoothly, build half-steps, or sink platforms into lava.
     *
     * Useful reference points:
     *   0  = floor level (ground)
     *   8  = top of a normal wall (matches WALL_HEIGHT)
     *  16  = double-wall height (very tall pillar)
     *
     * Pass -1 (or call clearTileHeight) to revert to the heightmap value.
     * Negative values other than -1 get clamped to 0.
     *
     * @param worldX X tile (0 to mapWidth-1)
     * @param worldZ Z tile (0 to mapHeight-1)
     * @param height new heightmap-space height. -1 = revert to heightmap.
     */
    //% blockId=u3d_settileheight block="U3D set tile height at x %worldX z %worldZ to %height"
    //% height.defl=0
    //% group="World" weight=100
    export function setTileHeight(worldX: number, worldZ: number, height: number) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        const idx = z * mapWidth + x
        if (height < 0 && height != -1) height = 0
        flatHeightOverride[idx] = height
    }

    /**
     * Remove any height override on a tile, reverting to the heightmap value.
     * @param worldX X tile (0 to mapWidth-1)
     * @param worldZ Z tile (0 to mapHeight-1)
     */
    //% blockId=u3d_cleartileheight block="U3D clear tile height at x %worldX z %worldZ"
    //% group="World" weight=90
    export function clearTileHeight(worldX: number, worldZ: number) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        flatHeightOverride[z * mapWidth + x] = -1
    }

    /**
     * Read the current effective height of a tile (in world units). Returns
     * the override if one is set, otherwise the heightmap pixel times the
     * vertical scale.
     */
    //% blockId=u3d_gettileheight block="U3D tile height at x %worldX z %worldZ"
    //% group="World" weight=80
    export function getTileHeight(worldX: number, worldZ: number): number {
        return terrain_height(worldX, worldZ)
    }

    /**
     * Set the height above which tiles physically block the player.
     * Any tile whose effective height (override or heightmap) exceeds this
     * value will stop the player from walking through it, just like a
     * tilemap wall — so doors, raised platforms, and setTileHeight walls
     * become real obstacles.
     *
     * Reference heights:
     *   0 = floor level
     *   2 = low barrier (player can't pass, can see over)
     *   8 = full wall height
     *
     * Set to 999 (default) to disable height collision entirely and rely
     * only on the tilemap wall flags.
     *
     * @param threshold height above which tiles block movement
     */
    //% blockId=u3d_setheightcollision block="U3D set height collision threshold %threshold"
    //% threshold.defl=2
    //% group="World" weight=70
    export function setHeightCollision(threshold: number) {
        heightCollisionThreshold = threshold
    }

    //% blockId=u3d_settilecolor block="U3D set tile color at x %worldX z %worldZ to %color"
    //% group="World" weight=60
    export function setTileColor(worldX: number, worldZ: number, color: number) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        flatColorMap[z * mapWidth + x] = color
    }

    //% blockId=u3d_getcameraangle block="U3D camera angle"
    //% group="Camera" weight=40
    export function getCameraAngle(): number { return cameraAngleDegrees }
}
