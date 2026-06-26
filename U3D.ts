//% color="#7C3AED" weight=100 icon="\uf1b2" block="U3D"
namespace U3D {

    let SKY = 12
    const SHADE_ROW = 1
    const SHADE_FALLBACK = 15
    let FOV = 0.88
    const VPROJ = 25
    let MAX_STEPS = 64
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
    let enginePaused = false
    let engineRunning = false
    let bakedLightingEnabled = true
    let sideShadingEnabled = true
    let floorTexturingEnabled = true
    let viewStepOffset = 0
    let heightCollisionThreshold = 999
    let stepHeightLimit = 3
    let moveSpeed = 0.06   // max heightmap units player can step up per tile
    let turnSpeed = 0.8     // degrees per d-pad tick

    // ── Spatial Audio (UTM integration) ─────────────────────────────────────
    interface SongData {
        stepMs: number
        sfxWave: WaveShape[]
        sfxStartFreq: number[]
        sfxEndFreq: number[]
        sfxStartVol: number[]
        sfxEndVol: number[]
        sfxDuration: number[]
        sfxEffect: SoundExpressionEffect[]
        sfxCurve: InterpolationCurve[]
        data: Buffer
    }
    interface SoundSource {
        songData: SongData
        x: number
        z: number
        maxDist: number
        loop: boolean
        active: boolean
        dataIndex: number
        stepTimer: number
    }
    const soundSources: SoundSource[] = []

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
    const flatColorMapOriginal: number[] = []
    const flatTileMap: number[] = []
    const flatIsCollisionWall: boolean[] = []
    const flatIsGrounded: boolean[] = []
    const flatTextures: number[][] = []
    const floorTextureFlat: number[] = []
    const blockColumns: number[][] = []
    let textureTiling = false


    let columnBuf: Buffer = null
    const shadeLUT: number[] = []
    const shadeLUT2: number[] = []
    const colDepth: number[] = []
    const colFloorY: number[] = []   // screen Y of nearest terrain top per column (for billboard vertical occlusion)
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
        public ax: number = 0      // acceleration X (world units / frame^2)
        public az: number = 0      // acceleration Z
        public drag: number = 1    // velocity multiplier per frame (1 = none, <1 = friction)
        public maxSpeed: number = 0 // 0 = uncapped
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
                flatColorMapOriginal[idx] = flatColorMap[idx]
                blockColumns[idx] = null
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

        cameraAngleDegrees += controller.dx() * turnSpeed
        if (cameraAngleDegrees < 0) cameraAngleDegrees += 360
        cameraAngleDegrees = cameraAngleDegrees % 360
        const lutIndex = cameraAngleDegrees | 0
        cameraCos = cosLUT[lutIndex]
        cameraSin = sinLUT[lutIndex]

        const moveX = controller.dy() * cameraSin * moveSpeed
        const moveZ = controller.dy() * cameraCos * moveSpeed
        const r = 0.2
        const padX = moveX > 0 ? r : -r
        const padZ = moveZ > 0 ? r : -r

        const currentGround = terrain_height(cameraX, cameraZ)
        const blockedX = is_wall(cameraX + moveX + padX, cameraZ) || is_height_wall(cameraX + moveX + padX, cameraZ)
        const blockedZ = is_wall(cameraX, cameraZ + moveZ + padZ) || is_height_wall(cameraX, cameraZ + moveZ + padZ)
        const newX = (moveX != 0 && !blockedX) ? cameraX + moveX : cameraX
        const newZ = (moveZ != 0 && !blockedZ) ? cameraZ + moveZ : cameraZ
        const newGround = terrain_height(newX, newZ)
        if (newGround - currentGround <= stepHeightLimit * verticalScale) {
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
                if (isHole && !flatTileMap[mapIdx] && !blockColumns[mapIdx]) {
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

                const invUseDist = 1 / useDist
                const sideShadeX = sideShadingEnabled && side == 1 && (x & 1) === 0
                const useShadeGlobal = bakedLightingEnabled && useDist > 12
                const useShadeDither = bakedLightingEnabled && useDist > 6 && !useShadeGlobal && (x & 1) === 0

                // Compute wallX once for texture X coordinate
                let wallX = side == 0 ? camZ + useDist * rayZ : camX + useDist * rayX
                const wallFloor = wallX < 0 ? (wallX | 0) - 1 : (wallX | 0)
                wallX -= wallFloor
                let texX = (wallX * 16) | 0
                if (texX >= 16) texX = 15

                const col_data = blockColumns[mapIdx]

                if (col_data) {
                    // ── Block column path: multiple stacked blocks ──────────
                    const numBlocks = (col_data.length / 3) | 0
                    const topBlockBase = (numBlocks - 1) * 3
                    const topBlockH = col_data[topBlockBase]

                    // Compute column top screen Y — skip if fully below watermark
                    const htColumnTop = (camY - topBlockH * vScale) * VPROJ
                    let columnTop = (centerY + htColumnTop * invUseDist) | 0
                    if (columnTop < 0) columnTop = 0

                    if (columnTop < watermark) {
                        let blockFirstBand = firstBand

                        for (let bi = numBlocks - 1; bi >= 0; bi--) {
                            if (watermark <= 0) break
                            const bBase = bi * 3
                            const bTopH = col_data[bBase]
                            const bColor = col_data[bBase + 1]
                            const bTexIdx = col_data[bBase + 2]
                            const bBotH = bi > 0 ? col_data[(bi - 1) * 3] : 0

                            const htTop = (camY - bTopH * vScale) * VPROJ
                            let bTop = (centerY + htTop * invUseDist) | 0
                            if (bTop < 0) bTop = 0
                            if (bTop >= watermark) continue

                            // Bottom of this block: project the block below's top,
                            // or use watermark for the bottom block (matches single
                            // block path — fills naturally to the floor with no gap).
                            let bBot: number
                            if (bi == 0) {
                                bBot = watermark
                            } else {
                                const htBot = (camY - bBotH * vScale) * VPROJ
                                bBot = (centerY + htBot * invUseDist) | 0
                                if (bBot > watermark) bBot = watermark
                                if (bBot < bTop) bBot = bTop
                            }
                            if (bTop >= bBot) continue

                            const bc = bakedLightingEnabled ? shadeLUT[bColor] : bColor
                            let faceCol = bColor
                            if (sideShadingEnabled && side == 1 && bakedLightingEnabled) faceCol = (x & 1) ? shadeLUT[bColor] : bColor

                            if (texturing && bTexIdx >= 0 && flatTextures[bTexIdx] && flatTextures[bTexIdx].length > 0) {
                                const cachedTex = flatTextures[bTexIdx]
                                const blockSpan = bBot - bTop
                                if (blockSpan > 0) {
                                    let stepPerRow = 0
                                    if (textureTiling) {
                                        const worldH = (bTopH - bBotH) * vScale
                                        const screenH1 = worldH * VPROJ * invUseDist
                                        stepPerRow = screenH1 > 0 ? ((16 << 8) / screenH1) | 0 : (16 << 8)
                                    } else {
                                        stepPerRow = ((16 << 8) / blockSpan) | 0
                                    }
                                    let accum = 0
                                    for (let y = bTop; y < bBot; y++) {
                                        let texY = textureTiling ? (accum >> 8) & 15 : Math.min(accum >> 8, 15)
                                        let px = cachedTex[(texY << 4) | texX]
                                        if (px) {
                                            if (useShadeGlobal || useShadeDither) px = shadeLUT[px]
                                            if (sideShadeX) px = shadeLUT[px]
                                            col[y] = px
                                        }
                                        accum += stepPerRow
                                    }
                                }
                            } else {
                                col.fill(blockFirstBand ? bc : faceCol, bTop, bBot - bTop)
                            }
                            watermark = bTop
                            blockFirstBand = false
                        }

                        // Top cap — flat top face using top block color
                        let topFar = (centerY + htColumnTop * invNextPerpEarly) | 0
                        if (topFar < 0) topFar = 0
                        if (topFar < watermark) {
                            const topBlockColor = col_data[topBlockBase + 1]
                            const capC = bakedLightingEnabled ? shadeLUT[topBlockColor] : topBlockColor
                            col.fill(capC, topFar, watermark - topFar)
                            watermark = topFar
                        }
                        firstBand = false
                    }

                    if (watermark <= 0) { lastDist = dist; break }
                    lastDist = dist

                } else {
                    // ── Single block path (original fast path) ──────────────
                    const tileIdx = flatTileMap[mapIdx]
                    let h = rawH
                    const hasTile = tileIdx != 0
                    if (hasTile && flatIsGrounded[tileIdx]) h += WALL_HEIGHT

                    const ht = (camY - h * vScale) * VPROJ

                    let top = (centerY + ht * invUseDist) | 0
                    let topFar = (centerY + ht * invNextPerpEarly) | 0
                    if (top < 0) top = 0
                    if (topFar < 0) topFar = 0
                    if (topFar > top) topFar = top

                    const c = rawC
                    const topColor = bakedLightingEnabled ? shadeLUT[c] : c
                    let faceColor = c
                    if (sideShadingEnabled && side == 1 && bakedLightingEnabled) faceColor = (x & 1) ? shadeLUT[c] : c

                    if (top < watermark) {
                        if (texturing && !firstBand && hasTile && flatTextures[tileIdx] && flatTextures[tileIdx].length > 0) {
                            const topU = centerY + ht * invUseDist
                            const baseU = centerY + camYVP * invUseDist
                            const fullSpan = baseU - topU
                            if (fullSpan > 0) {
                                let stepPerRow = 0
                                let accum = 0
                                if (textureTiling) {
                                    stepPerRow = ((16 << 8) / (WALL_HEIGHT * vScale * VPROJ * invUseDist)) | 0
                                    accum = 0
                                } else {
                                    stepPerRow = ((16 << 8) / fullSpan) | 0
                                    accum = ((top - topU) * stepPerRow) | 0
                                    if (accum < 0) accum = 0
                                }
                                const cachedTex = flatTextures[tileIdx]
                                for (let y = top; y < watermark; y++) {
                                    let texY = textureTiling ? (accum >> 8) & 15 : Math.min(accum >> 8, 15)
                                    let px = cachedTex[(texY << 4) | texX]
                                    if (px) {
                                        if (useShadeGlobal || useShadeDither) px = shadeLUT[px]
                                        if (sideShadeX) px = shadeLUT[px]
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
                }
                firstBand = false
                if (watermark <= 0) { lastDist = dist; break }
                lastDist = dist
            }

            colDepth[x] = lastDist
            colFloorY[x] = watermark
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

                // Per-column occlusion against terrain.
                // colDepth[screenX] is the distance of the nearest wall/terrain in
                // this column; colFloorY[screenX] is the screen Y of its top edge.
                // If the billboard is behind that terrain (tY greater), clip its
                // bottom so only the part rising above the terrain top is drawn,
                // instead of either skipping the whole column or drawing over it.
                let colYEnd = yEnd
                if (colDepth[screenX] < tY) {
                    const floorY = colFloorY[screenX]
                    // Terrain fully hides this column's sprite span — skip.
                    if (floorY <= yStart) continue
                    // Otherwise only draw down to the terrain's top edge.
                    if (floorY < colYEnd) colYEnd = floorY
                }
                if (colYEnd <= yStart) continue

                const texX = (sx * texXStep >> 8)
                const texXClamped = texX < imgW ? texX : imgW - 1
                const dither = shadeSprite && !shadeAll && (screenX & 1) === 0

                let texYAcc = texYInit
                for (let screenY = yStart; screenY < colYEnd; screenY++) {
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
            const hasMotion = bb.vx != 0 || bb.vz != 0 || bb.ax != 0 || bb.az != 0
            if (!hasBob && !hasMotion && !bb.follows) continue

            let cx = bb.spr.x / 16
            let cz = bb.spr.y / 16

            // Apply acceleration and drag (skipped for follow billboards, which
            // steer themselves via the flow field / ghost homing below).
            if (!bb.follows) {
                bb.vx += bb.ax
                bb.vz += bb.az
                if (bb.drag != 1) {
                    bb.vx *= bb.drag
                    bb.vz *= bb.drag
                }
                if (bb.maxSpeed > 0) {
                    const sp = Math.sqrt(bb.vx * bb.vx + bb.vz * bb.vz)
                    if (sp > bb.maxSpeed) {
                        const k = bb.maxSpeed / sp
                        bb.vx *= k
                        bb.vz *= k
                    }
                }
            }

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
        engineRunning = true
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

            if (!engineRunning || enginePaused) return
            update_billboards()
            update_spatial_audio()
            const hasDpad = controller.dx() != 0 || controller.dy() != 0
            if (hasDpad) {
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
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return 0
        const idx = z * mapWidth + x
        const ov = flatHeightOverride[idx]
        return ov >= 0 ? ov : flatHeightMap[idx]
    }

    /**
     * Set the height above which tiles physically block the player.
     * Any tile whose effective height (override or heightmap) exceeds this
     * value will stop the player from walking through it, just like a
     * tilemap wall — so doors, raised platforms, and setTileHeight walls
     * become real obstacles.
     *
     * Reference heights (heightmap units, same as setTileHeight):
     *   0 = floor level
     *   2 = low barrier (player can't pass, can see over)
     *   8 = full wall height (matches WALL_HEIGHT)
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

    //% blockId=u3d_gettilecolor block="U3D tile color at x %worldX z %worldZ"
    //% group="World" weight=55
    export function getTileColor(worldX: number, worldZ: number): number {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return 0
        return flatColorMap[z * mapWidth + x]
    }

    //% blockId=u3d_resettilecolor block="U3D reset tile color at x %worldX z %worldZ"
    //% group="World" weight=50
    export function resetTileColor(worldX: number, worldZ: number) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        const idx = z * mapWidth + x
        flatColorMap[idx] = flatColorMapOriginal[idx]
    }

    //% blockId=u3d_resetallcolors block="U3D reset all tile colors"
    //% group="World" weight=45
    export function resetAllTileColors() {
        const total = mapWidth * mapHeight
        for (let i = 0; i < total; i++) flatColorMap[i] = flatColorMapOriginal[i]
    }

    //% blockId=u3d_setmovement block="U3D set camera movement %on"
    //% on.defl=true
    //% group="Camera" weight=35
    export function setCameraMovement(on: boolean) {
        cameraMovementEnabled = on
    }

    //% blockId=u3d_setstepheight block="U3D set step height limit %height"
    //% height.defl=1
    //% group="Settings" weight=70
    export function setStepHeight(height: number) {
        stepHeightLimit = height
    }

    //% blockId=u3d_setfov block="U3D set FOV %fov"
    //% fov.defl=0.88
    //% group="Settings" weight=75
    export function setFOV(fov: number) {
        FOV = fov
    }

    //% blockId=u3d_setspeed block="U3D set move speed %speed"
    //% speed.defl=0.06
    //% group="Settings" weight=72
    export function setMoveSpeed(speed: number) {
        moveSpeed = speed
    }

    //% blockId=u3d_getspeed block="U3D move speed"
    //% group="Settings" weight=71
    export function getMoveSpeed(): number {
        return moveSpeed
    }

    //% blockId=u3d_renderdistance
    export enum RenderDistance {
        //% block="low"
        Low = 0,
        //% block="normal"
        Normal = 1,
        //% block="high"
        High = 2,
        //% block="extreme"
        Extreme = 3
    }

    /**
     * Set how far the camera can see. Higher values look better but cost
     * more CPU — lower values run faster. Tune this to your map size.
     *
     *   Low     — small rooms, tight corridors, max performance
     *   Normal  — default, good for most maps up to 64×64
     *   High    — large open areas, maps up to 128×128
     *   Extreme — huge maps or very long sightlines, slowest
     */
    //% blockId=u3d_setrenderdistance block="U3D set render distance %distance"
    //% distance.defl=RenderDistance.Normal
    //% group="Settings" weight=76
    export function setRenderDistance(distance: RenderDistance) {
        if (distance == RenderDistance.Low) MAX_STEPS = 16
        else if (distance == RenderDistance.Normal) MAX_STEPS = 32
        else if (distance == RenderDistance.High) MAX_STEPS = 64
        else MAX_STEPS = 128
    }

    /**
     * Set the sky color (the color above the horizon).
     * Uses MakeCode palette color index 0-15.
     * Default is 12 (dark blue).
     */
    //% blockId=u3d_setskycolor block="U3D set sky color %color"
    //% color.defl=12 color.shadow=colorindexpicker
    //% group="Settings" weight=78
    export function setSkyColor(color: number) {
        SKY = color
    }

    /**
     * Pause the engine. The screen freezes — no rendering, no movement,
     * no billboard updates. Call resumeEngine() to continue.
     * Useful for menus, cutscenes, dialogue, or any moment where the
     * game world should stop without clearing the screen.
     */
    //% blockId=u3d_pauseengine block="U3D pause engine"
    //% group="Settings" weight=65
    export function pauseEngine() {
        enginePaused = true
        cameraMovementEnabled = false
    }

    /**
     * Resume the engine after a pause.
     */
    //% blockId=u3d_resumeengine block="U3D resume engine"
    //% group="Settings" weight=64
    export function resumeEngine() {
        enginePaused = false
        cameraMovementEnabled = true
    }

    /**
     * Stop the engine completely and clear the screen.
     * Use this for game over screens, scene transitions, or
     * any moment where you want to return full control to your code.
     * Call start() again to restart from scratch.
     */
    //% blockId=u3d_stopengine block="U3D stop engine"
    //% group="Settings" weight=63
    export function stopEngine() {
        engineRunning = false
        enginePaused = false
        cameraMovementEnabled = false
        if (bgImage) bgImage.fill(0)
    }

    /**
     * Stack blocks on a tile. Each block has a top height (in heightmap units),
     * a color, and an optional texture tile index (-1 for color only).
     * Blocks are ordered bottom to top.
     *
     * Example — dirt on stone:
     *   U3D.setBlockColumn(5, 5, [4, 6, -1, 8, 7, -1])
     *   means: block 1 goes from 0 to height 4 in color 6,
     *          block 2 goes from 4 to height 8 in color 7.
     *
     * @param worldX X tile
     * @param worldZ Z tile
     * @param blocks flat array [topH, color, texIdx, topH, color, texIdx, ...]
     */
    //% blockId=u3d_setblockcolumn block="U3D set block column at x %worldX z %worldZ to %blocks"
    //% group="World" weight=42
    export function setBlockColumn(worldX: number, worldZ: number, blocks: number[]) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        blockColumns[z * mapWidth + x] = blocks
    }

    /**
     * Stack a single block on top of whatever is already at this tile.
     * If no column exists yet, creates one starting from the base heightmap height.
     * @param worldX X tile
     * @param worldZ Z tile
     * @param topHeight top of this block in heightmap units
     * @param color color index 0-15
     * @param texIdx tileset index for texture, or -1 for solid color
     */
    //% blockId=u3d_stackblock block="U3D stack block at x %worldX z %worldZ top %topHeight color %color tex %texIdx"
    //% texIdx.defl=-1
    //% group="World" weight=41
    export function stackBlock(worldX: number, worldZ: number, topHeight: number, color: number, texIdx: number = -1) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        const idx = z * mapWidth + x
        if (!blockColumns[idx]) {
            const baseH = flatHeightMap[idx]
            blockColumns[idx] = [baseH, flatColorMap[idx], -1]
        }
        blockColumns[idx].push(topHeight)
        blockColumns[idx].push(color)
        blockColumns[idx].push(texIdx)
    }

    /**
     * Remove all stacked blocks from a tile, reverting to the single-block fast path.
     */
    //% blockId=u3d_clearblockcolumn block="U3D clear block column at x %worldX z %worldZ"
    //% group="World" weight=40
    export function clearBlockColumn(worldX: number, worldZ: number) {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return
        blockColumns[z * mapWidth + x] = null
    }

    /**
     * Remove all block columns across the entire map.
     */
    //% blockId=u3d_clearallcolumns block="U3D clear all block columns"
    //% group="World" weight=39
    export function clearAllBlockColumns() {
        const total = mapWidth * mapHeight
        for (let i = 0; i < total; i++) blockColumns[i] = null
    }

    /**
     * Toggle texture tiling mode.
     * Off (default): texture stretches to fill the entire wall face.
     * On: texture tiles at a fixed world scale — one tile per WALL_HEIGHT units.
     *     Stacked blocks each show the full texture regardless of their thickness.
     */
    //% blockId=u3d_settexturetiling block="U3D set texture tiling %on"
    //% on.defl=false
    //% group="Settings" weight=69
    export function setTextureTiling(on: boolean) {
        textureTiling = on
    }

    /**
     * Returns the world height (in heightmap units) that makes a wall face
     * appear as a perfect square when viewed straight-on. Use this as your
     * standard block height for Minecraft-style stacking so textures look 1:1.
     */
    //% blockId=u3d_getblockheight block="U3D block height for 1:1 texture"
    //% group="World" weight=38
    export function getBlockHeight(): number {
        return WALL_HEIGHT
    }

    /**
     * Get the raw block column data for a tile, or null if none exists.
     * Returns a reference to the internal array — handle with care.
     */
    //% blockId=u3d_getblockcolumn block="U3D get block column at x %worldX z %worldZ"
    //% group="World" weight=37
    export function getBlockColumn(worldX: number, worldZ: number): number[] {
        const x = worldX | 0
        const z = worldZ | 0
        if (x < 0 || x >= mapWidth || z < 0 || z >= mapHeight) return null
        return blockColumns[z * mapWidth + x]
    }

    /**
     * Set a billboard's velocity directly (world units per frame).
     */
    //% blockId=u3d_setbillboardvelocity block="U3D set %spr velocity vx %vx vz %vz"
    //% group="Billboards" weight=68
    export function setBillboardVelocity(spr: Sprite, vx: number, vz: number) {
        for (let i = 0; i < billboards.length; i++) {
            const bb = billboards[i]
            if (bb.spr === spr) { bb.vx = vx; bb.vz = vz; return }
        }
    }

    /**
     * Set a billboard's acceleration (added to velocity each frame).
     * Does not apply while the billboard is set to follow the camera.
     */
    //% blockId=u3d_setbillboardaccel block="U3D set %spr acceleration ax %ax az %az"
    //% group="Billboards" weight=67
    export function setBillboardAcceleration(spr: Sprite, ax: number, az: number) {
        for (let i = 0; i < billboards.length; i++) {
            const bb = billboards[i]
            if (bb.spr === spr) { bb.ax = ax; bb.az = az; return }
        }
    }

    /**
     * Set a billboard's drag — velocity is multiplied by this each frame.
     * 1 = no friction, 0.9 = gradual slowdown, 0 = instant stop.
     */
    //% blockId=u3d_setbillboarddrag block="U3D set %spr drag %drag"
    //% drag.defl=1 drag.min=0 drag.max=1
    //% group="Billboards" weight=66
    export function setBillboardDrag(spr: Sprite, drag: number) {
        for (let i = 0; i < billboards.length; i++) {
            const bb = billboards[i]
            if (bb.spr === spr) { bb.drag = drag; return }
        }
    }

    /**
     * Cap a billboard's speed. 0 = uncapped.
     */
    //% blockId=u3d_setbillboardmaxspeed block="U3D set %spr max speed %maxSpeed"
    //% group="Billboards" weight=65
    export function setBillboardMaxSpeed(spr: Sprite, maxSpeed: number) {
        for (let i = 0; i < billboards.length; i++) {
            const bb = billboards[i]
            if (bb.spr === spr) { bb.maxSpeed = maxSpeed; return }
        }
    }

    /**
     * Get a billboard's current speed (magnitude of its velocity),
     * in world units per frame. Returns 0 if the sprite isn't a billboard.
     */
    //% blockId=u3d_getbillboardspeed block="U3D %spr speed"
    //% group="Billboards" weight=64
    export function getBillboardSpeed(spr: Sprite): number {
        for (let i = 0; i < billboards.length; i++) {
            const bb = billboards[i]
            if (bb.spr === spr) return Math.sqrt(bb.vx * bb.vx + bb.vz * bb.vz)
        }
        return 0
    }

    /**
     * Toggle the vertical line shading on east/west-facing wall faces.
     * On by default — gives walls a sense of depth.
     * Turn off for a flat-lit look or when it conflicts with your art style.
     */
    //% blockId=u3d_setsideshading block="U3D set side shading %on"
    //% on.defl=true
    //% group="Settings" weight=73
    export function setSideShading(on: boolean) {
        sideShadingEnabled = on
    }

    /**
     * Set the camera angle directly (degrees, 0–360).
     * Use this with mouse/gamepad input to control turning manually.
     */
    //% blockId=u3d_setcameraangle block="U3D set camera angle %degrees"
    //% group="Camera" weight=45
    export function setCameraAngle(degrees: number) {
        cameraAngleDegrees = degrees % 360
        if (cameraAngleDegrees < 0) cameraAngleDegrees += 360
        const li = cameraAngleDegrees | 0
        cameraCos = cosLUT[li]
        cameraSin = sinLUT[li]
    }

    /**
     * Set how many degrees the camera turns per D-pad tick.
     * Default is 0.8. Lower = slower turning, higher = snappier.
     */
    //% blockId=u3d_setturnspeed block="U3D set turn speed %speed"
    //% speed.defl=0.8
    //% group="Camera" weight=34
    export function setTurnSpeed(speed: number) {
        turnSpeed = speed
    }

    /**
     * Get a billboard's world X position (tile units).
     */
    //% blockId=u3d_getbbx block="U3D %spr world X"
    //% group="Billboards" weight=62
    export function getBillboardX(spr: Sprite): number {
        return spr.x / 16
    }

    /**
     * Get a billboard's world Z position (tile units).
     */
    //% blockId=u3d_getbbz block="U3D %spr world Z"
    //% group="Billboards" weight=61
    export function getBillboardZ(spr: Sprite): number {
        return spr.y / 16
    }

    /**
     * Get a billboard's world Y (height) position.
     */
    //% blockId=u3d_getbby block="U3D %spr world Y"
    //% group="Billboards" weight=60
    export function getBillboardY(spr: Sprite): number {
        for (let i = 0; i < billboards.length; i++) {
            if (billboards[i].spr === spr) return billboards[i].worldY
        }
        return 0
    }

    /**
     * Set a billboard's world X position (tile units).
     */
    //% blockId=u3d_setbbx block="U3D set %spr world X to %x"
    //% group="Billboards" weight=59
    export function setBillboardX(spr: Sprite, x: number) {
        spr.x = x * 16
    }

    /**
     * Set a billboard's world Z position (tile units).
     */
    //% blockId=u3d_setbbz block="U3D set %spr world Z to %z"
    //% group="Billboards" weight=58
    export function setBillboardZ(spr: Sprite, z: number) {
        spr.y = z * 16
    }

    /**
     * Set a billboard's world Y (height) position.
     */
    //% blockId=u3d_setbby block="U3D set %spr world Y to %y"
    //% group="Billboards" weight=57
    export function setBillboardY(spr: Sprite, y: number) {
        for (let i = 0; i < billboards.length; i++) {
            if (billboards[i].spr === spr) {
                billboards[i].worldY = y
                billboards[i].bobBaseY = y
                return
            }
        }
    }

    /**
     * Add a UTM sound source at a world position.
     * The sound plays automatically each frame, with volume scaling
     * based on distance from the camera. Fully integrated with the
     * U3D game loop — no timer or manual update call needed.
     *
     * Build a SongData object from your UTM export and pass it here.
     * Example:
     *   U3D.addSoundSource({
     *     stepMs: 200,
     *     sfxWave: [WaveShape.Sine],
     *     sfxStartFreq: [440], sfxEndFreq: [440],
     *     sfxStartVol: [255], sfxEndVol: [0],
     *     sfxDuration: [200],
     *     sfxEffect: [SoundExpressionEffect.None],
     *     sfxCurve: [InterpolationCurve.Linear],
     *     data: hex`01 00`
     *   }, 5, 8, 10, true)
     *
     * @param songData UTM SongData object (from your UTM export)
     * @param worldX   X tile position of the sound source
     * @param worldZ   Z tile position of the sound source
     * @param maxDist  how many tiles away the sound can be heard
     * @param loop     whether to loop the song (default true)
     */
    //% blockId=u3d_addsoundsource block="U3D play UTM song at x %worldX z %worldZ max distance %maxDist loop %loop"
    //% maxDist.defl=8 loop.defl=true
    //% group="Audio" weight=100
    export function playSongAt(songData: SongData, worldX: number, worldZ: number, maxDist: number, loop: boolean = true) {
        soundSources.push({
            songData, x: worldX, z: worldZ,
            maxDist, loop, active: true,
            dataIndex: 0, stepTimer: 0
        })
    }

    /**
     * Remove all sound sources at a tile position.
     */
    //% blockId=u3d_removesoundsource block="U3D remove sound source at x %worldX z %worldZ"
    //% group="Audio" weight=95
    export function removeSoundSource(worldX: number, worldZ: number) {
        for (let i = soundSources.length - 1; i >= 0; i--) {
            if (soundSources[i].x === worldX && soundSources[i].z === worldZ) {
                soundSources.splice(i, 1)
            }
        }
    }

    /**
     * Move a sound source from one tile to another.
     * Use this for moving enemies or objects that emit sound.
     */
    //% blockId=u3d_movesoundsource block="U3D move sound source from x %oldX z %oldZ to x %newX z %newZ"
    //% group="Audio" weight=90
    export function moveSoundSource(oldX: number, oldZ: number, newX: number, newZ: number) {
        for (let i = 0; i < soundSources.length; i++) {
            if (soundSources[i].x === oldX && soundSources[i].z === oldZ) {
                soundSources[i].x = newX
                soundSources[i].z = newZ
            }
        }
    }

    /**
     * Remove all active sound sources.
     */
    //% blockId=u3d_clearallsoundsources block="U3D clear all sound sources"
    //% group="Audio" weight=85
    export function clearAllSoundSources() {
        soundSources.splice(0, soundSources.length)
    }

    /**
     * Play a single MakeCode sound effect at a world position with distance-based
     * volume falloff. No SongData or UTM required — just pass any sound effect.
     * Volume scales from full at the source tile to silent at maxDist tiles away.
     * If the camera is beyond maxDist, nothing plays.
     *
     * @param sound    any MakeCode sound effect (music.createSoundEffect, music.melodyPlayable, etc.)
     * @param worldX   X tile position of the sound
     * @param worldZ   Z tile position of the sound
     * @param maxDist  audible radius in tiles
     */
    //% blockId=u3d_playsoundat block="U3D play sound %sound at x %worldX z %worldZ max distance %maxDist"
    //% maxDist.defl=8
    //% sound.shadow=music_create_sound_effect
    //% group="Audio" weight=99
    export function playSoundAt(sound: music.Playable, worldX: number, worldZ: number, maxDist: number) {
        const dx = worldX - cameraX
        const dz = worldZ - cameraZ
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist >= maxDist) return
        const volMult = 1 - dist / maxDist
        const prevVol = music.volume()
        music.setVolume(Math.round(prevVol * volMult))
        music.play(sound, music.PlaybackMode.InBackground)
        music.setVolume(prevVol)
    }


}
