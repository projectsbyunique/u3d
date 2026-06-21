/*
U3D.setMaps(
    assets.image`height`,
    assets.image`map`,
    assets.image`shader`,
    assets.image`lava`,
    tilemap`Tilemap Test`
)
U3D.setGroundedTiles([assets.tile`wall_grounded`])
U3D.setHeightCollision(5)
U3D.setCamera(32, 32, 6, 0)
U3D.start()

let texturing = true

controller.menu.onEvent(ControllerButtonEvent.Pressed, function() {
    texturing = !texturing
    U3D.setTexturing(texturing)
})

let startMenu = true
U3D.spinAround(U3D.getCameraX(), U3D.getCameraZ(), 10, 0.5)

controller.A.onEvent(ControllerButtonEvent.Pressed, function () {
    if (startMenu) {
        startMenu = false
        U3D.endSpin()
        U3D.setCamera(32, 32, 6, 0)
    }
})

const DOOR_X_MIN = 30
const DOOR_X_MAX = 33
const DOOR_Z = 19
const TRIGGER_RANGE = 5
const DOOR_CLOSED_H = 15
const DOOR_OPEN_H = 2
const DOOR_SPEED = 0.6
let doorHeight = DOOR_CLOSED_H

game.onUpdate(function () {
    //if (startMenu) return
    const px = U3D.getCameraX()
    const pz = U3D.getCameraZ()
    const inX = px >= DOOR_X_MIN - TRIGGER_RANGE && px <= DOOR_X_MAX + TRIGGER_RANGE
    const inZ = pz >= DOOR_Z - TRIGGER_RANGE && pz <= DOOR_Z + TRIGGER_RANGE
    const target = (inX && inZ) ? DOOR_OPEN_H : DOOR_CLOSED_H
    if (doorHeight < target) {
        doorHeight = Math.min(doorHeight + DOOR_SPEED, target)
    } else if (doorHeight > target) {
        doorHeight = Math.max(doorHeight - DOOR_SPEED, target)
    }
    for (let x = DOOR_X_MIN; x <= DOOR_X_MAX; x++) {
        U3D.setTileHeight(x, DOOR_Z, doorHeight)
    }
})

game.onPaint(function () {
    screen.fillRect(0, 0, 46, 24, 15)
    screen.print("X " + (Math.round(U3D.getCameraX() * 10) / 10), 1, 1, 1, image.font5)
    screen.print("Y " + (Math.round(U3D.getCameraY() * 10) / 10), 1, 8, 1, image.font5)
    screen.print("Z " + (Math.round(U3D.getCameraZ() * 10) / 10), 1, 15, 1, image.font5)
})
*/