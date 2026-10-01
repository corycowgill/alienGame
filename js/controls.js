import * as THREE from 'three';
// controls.js - Pointer-lock FPS controls + Xbox controller support
export class FPSControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.isLocked = false;

    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.sprint = false;
    this.jump = false;

    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();

    // Reusable temp objects to avoid per-frame allocations
    this._tmpForward = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3(0, 1, 0);
    this._tmpNewPos = new THREE.Vector3();
    this._tmpCheckPoint = new THREE.Vector3();
    this._tmpBox = new THREE.Box3();

    this.playerHeight = 1.7;
    this.speed = 12;
    this.sprintMultiplier = 1.8;
    this.jumpForce = 8;
    this.gravity = 20;
    this.onGround = true;
    this.verticalVelocity = 0;

    // Dash
    this.dashCooldown = 0;
    this.dashCooldownMax = 2.0;
    this.dashDuration = 0.15;
    this.dashTimer = 0;
    this.dashSpeed = 50;

    this.sensitivity = 0.002;

    // Head bob
    this.headBobPhase = 0;
    this.headBobAmount = 0;

    // Touch state (mobile / iOS)
    this.touchEnabled = false;
    this.touchMoveX = 0; // -1..1 virtual stick
    this.touchMoveY = 0;
    this.touchLookDX = 0; // consumed per frame
    this.touchLookDY = 0;
    this.touchSensitivity = 0.004;
    this._moveTouchId = null;
    this._lookTouchId = null;
    this._moveOrigin = { x: 0, y: 0 };

    // Gamepad state
    this.gamepadIndex = -1;
    this.gamepadLookX = 0;
    this.gamepadLookY = 0;
    this.gamepadMoveX = 0;
    this.gamepadMoveY = 0;
    this.gamepadSensitivity = 3.0;
    this.gamepadDeadzone = 0.15;
    this.gamepadButtons = {};
    this.gamepadButtonsPrev = {};
    // Callbacks for gamepad button actions (set by main.js)
    this.onGamepadFire = null;
    this.onGamepadZoom = null;
    this.onGamepadWeapon1 = null;
    this.onGamepadWeapon2 = null;
    this.onGamepadWeapon3 = null;
    this.onGamepadHelp = null;
    this.onGamepadStart = null;

    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerlockChange = this._onPointerlockChange.bind(this);

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onPointerlockChange);

    // Gamepad connect/disconnect
    window.addEventListener('gamepadconnected', (e) => {
      console.log('Gamepad connected:', e.gamepad.id);
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      console.log('Gamepad disconnected:', e.gamepad.id);
      if (e.gamepad.index === this.gamepadIndex) {
        this.gamepadIndex = -1;
      }
    });
  }

  get hasGamepad() {
    return this.gamepadIndex >= 0;
  }

  lock() {
    if (this.touchEnabled) {
      this.isLocked = true;
      return;
    }
    this.domElement.requestPointerLock();
  }

  unlock() {
    if (this.touchEnabled) {
      this.isLocked = false;
      return;
    }
    document.exitPointerLock();
  }

  // Enable touch controls for mobile/iOS. Callbacks: onFire, onJump, onCycleWeapon.
  enableTouchControls(callbacks = {}) {
    this.touchEnabled = true;
    this.onTouchFire = callbacks.onFire || null;
    this.onTouchJump = callbacks.onJump || null;
    this.onTouchCycleWeapon = callbacks.onCycleWeapon || null;

    const halfW = () => window.innerWidth / 2;

    const onTouchStart = (e) => {
      if (!this.isLocked) return;
      for (const t of e.changedTouches) {
        // Ignore touches on UI buttons (they have their own handlers)
        const target = t.target;
        if (target && target.closest && target.closest('.touch-btn')) continue;
        if (t.clientX < halfW()) {
          // Left half = virtual joystick
          if (this._moveTouchId === null) {
            this._moveTouchId = t.identifier;
            this._moveOrigin.x = t.clientX;
            this._moveOrigin.y = t.clientY;
            this.touchMoveX = 0;
            this.touchMoveY = 0;
            const stick = document.getElementById('touch-stick');
            if (stick) {
              stick.style.display = 'block';
              stick.style.left = (t.clientX - 60) + 'px';
              stick.style.top = (t.clientY - 60) + 'px';
              const knob = document.getElementById('touch-stick-knob');
              if (knob) { knob.style.left = '40px'; knob.style.top = '40px'; }
            }
          }
        } else {
          // Right half = look
          if (this._lookTouchId === null) {
            this._lookTouchId = t.identifier;
            this._lookLastX = t.clientX;
            this._lookLastY = t.clientY;
          }
        }
      }
      e.preventDefault();
    };

    const onTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._moveTouchId) {
          const dx = t.clientX - this._moveOrigin.x;
          const dy = t.clientY - this._moveOrigin.y;
          const maxR = 50;
          const len = Math.hypot(dx, dy);
          const cdx = len > maxR ? dx * maxR / len : dx;
          const cdy = len > maxR ? dy * maxR / len : dy;
          this.touchMoveX = cdx / maxR;
          this.touchMoveY = cdy / maxR;
          const knob = document.getElementById('touch-stick-knob');
          if (knob) {
            knob.style.left = (40 + cdx) + 'px';
            knob.style.top = (40 + cdy) + 'px';
          }
        } else if (t.identifier === this._lookTouchId) {
          this.touchLookDX += (t.clientX - this._lookLastX);
          this.touchLookDY += (t.clientY - this._lookLastY);
          this._lookLastX = t.clientX;
          this._lookLastY = t.clientY;
        }
      }
      e.preventDefault();
    };

    const onTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._moveTouchId) {
          this._moveTouchId = null;
          this.touchMoveX = 0;
          this.touchMoveY = 0;
          const stick = document.getElementById('touch-stick');
          if (stick) stick.style.display = 'none';
        } else if (t.identifier === this._lookTouchId) {
          this._lookTouchId = null;
        }
      }
    };

    this.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    this.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    this.domElement.addEventListener('touchend', onTouchEnd);
    this.domElement.addEventListener('touchcancel', onTouchEnd);
  }

  touchJump() {
    if (this.onGround) {
      this.verticalVelocity = this.jumpForce;
      this.onGround = false;
    }
  }

  _onPointerlockChange() {
    this.isLocked = document.pointerLockElement === this.domElement;
  }

  _onMouseMove(e) {
    if (!this.isLocked) return;
    this.euler.setFromQuaternion(this.camera.quaternion);
    this.euler.y -= e.movementX * this.sensitivity;
    this.euler.x -= e.movementY * this.sensitivity;
    this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x));
    this.camera.quaternion.setFromEuler(this.euler);
  }

  _onKeyDown(e) {
    switch (e.code) {
      case 'KeyW': this.moveForward = true; break;
      case 'KeyS': this.moveBackward = true; break;
      case 'KeyA': this.moveLeft = true; break;
      case 'KeyD': this.moveRight = true; break;
      case 'ShiftLeft': case 'ShiftRight': this.sprint = true; break;
      case 'Space':
        if (this.onGround) {
          this.verticalVelocity = this.jumpForce;
          this.onGround = false;
        }
        break;
      case 'KeyE':
        if (this.dashCooldown <= 0 && this.dashTimer <= 0) {
          this.dashTimer = this.dashDuration;
        }
        break;
    }
  }

  _onKeyUp(e) {
    switch (e.code) {
      case 'KeyW': this.moveForward = false; break;
      case 'KeyS': this.moveBackward = false; break;
      case 'KeyA': this.moveLeft = false; break;
      case 'KeyD': this.moveRight = false; break;
      case 'ShiftLeft': case 'ShiftRight': this.sprint = false; break;
    }
  }

  // Apply deadzone to analog stick value
  _applyDeadzone(value) {
    if (Math.abs(value) < this.gamepadDeadzone) return 0;
    const sign = value > 0 ? 1 : -1;
    return sign * (Math.abs(value) - this.gamepadDeadzone) / (1 - this.gamepadDeadzone);
  }

  // Returns true if button was just pressed this frame (not held)
  gamepadPressed(buttonIndex) {
    return this.gamepadButtons[buttonIndex] && !this.gamepadButtonsPrev[buttonIndex];
  }

  // Poll gamepad state each frame
  _pollGamepad(delta) {
    if (this.gamepadIndex < 0) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.gamepadIndex];
    if (!gp) return;

    // Save previous button state for edge detection
    this.gamepadButtonsPrev = { ...this.gamepadButtons };
    this.gamepadButtons = {};
    for (let i = 0; i < gp.buttons.length; i++) {
      this.gamepadButtons[i] = gp.buttons[i].pressed;
    }

    // Xbox controller standard mapping:
    // Axes: 0=LeftStickX, 1=LeftStickY, 2=RightStickX, 3=RightStickY
    // Buttons:
    //  0=A, 1=B, 2=X, 3=Y
    //  4=LB, 5=RB
    //  6=LT, 7=RT
    //  8=Back/Select, 9=Start
    //  10=LeftStickPress, 11=RightStickPress
    //  12=DPadUp, 13=DPadDown, 14=DPadLeft, 15=DPadRight

    // Left stick -> movement
    this.gamepadMoveX = this._applyDeadzone(gp.axes[0]);
    this.gamepadMoveY = this._applyDeadzone(gp.axes[1]);

    // Right stick -> look
    this.gamepadLookX = this._applyDeadzone(gp.axes[2]);
    this.gamepadLookY = this._applyDeadzone(gp.axes[3]);

    // Sprint = Left Stick Press (L3)
    this.sprint = this.sprint || gp.buttons[10]?.pressed;

    // Jump = A button
    if (this.gamepadPressed(0) && this.onGround) {
      this.verticalVelocity = this.jumpForce;
      this.onGround = false;
    }

    // RT (7) = Fire
    if (this.gamepadPressed(7) && this.onGamepadFire) {
      this.onGamepadFire();
    }
    // Also support holding RT for automatic fire
    if (gp.buttons[7]?.pressed && this.onGamepadFireHold) {
      this.onGamepadFireHold();
    }

    // LT (6) = Zoom/ADS
    if (this.gamepadPressed(6) && this.onGamepadZoom) {
      this.onGamepadZoom();
    }

    // Weapon switching: DPad Left/Up/Right or X/Y/B
    if (this.gamepadPressed(14) && this.onGamepadWeapon1) this.onGamepadWeapon1(); // DPad Left
    if (this.gamepadPressed(12) && this.onGamepadWeapon2) this.onGamepadWeapon2(); // DPad Up
    if (this.gamepadPressed(15) && this.onGamepadWeapon3) this.onGamepadWeapon3(); // DPad Right

    // Also: Y = cycle weapon forward
    if (this.gamepadPressed(3) && this.onGamepadCycleWeapon) {
      this.onGamepadCycleWeapon();
    }

    // LB (4) = Grenade
    if (this.gamepadPressed(4) && this.onGamepadGrenade) {
      this.onGamepadGrenade();
    }

    // Back/Select (8) = Help
    if (this.gamepadPressed(8) && this.onGamepadHelp) {
      this.onGamepadHelp();
    }

    // Start (9) = Pause / Start game
    if (this.gamepadPressed(9) && this.onGamepadStart) {
      this.onGamepadStart();
    }

    // B (1) = close help / back
    if (this.gamepadPressed(1) && this.onGamepadBack) {
      this.onGamepadBack();
    }

    // Apply right stick look
    if (this.gamepadLookX !== 0 || this.gamepadLookY !== 0) {
      this.euler.setFromQuaternion(this.camera.quaternion);
      this.euler.y -= this.gamepadLookX * this.gamepadSensitivity * delta;
      this.euler.x -= this.gamepadLookY * this.gamepadSensitivity * delta;
      this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x));
      this.camera.quaternion.setFromEuler(this.euler);
    }
  }

  update(delta, colliders) {
    // Always poll gamepad
    this._pollGamepad(delta);

    // Apply pending touch look delta
    if (this.touchEnabled && (this.touchLookDX !== 0 || this.touchLookDY !== 0)) {
      this.euler.setFromQuaternion(this.camera.quaternion);
      this.euler.y -= this.touchLookDX * this.touchSensitivity;
      this.euler.x -= this.touchLookDY * this.touchSensitivity;
      this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x));
      this.camera.quaternion.setFromEuler(this.euler);
      this.touchLookDX = 0;
      this.touchLookDY = 0;
    }

    // Allow gamepad / touch to work even without pointer lock
    const useGamepad = this.hasGamepad;
    const useTouch = this.touchEnabled && this.isLocked;
    if (!this.isLocked && !useGamepad && !useTouch) return;

    let speed = this.speed * (this.sprint ? this.sprintMultiplier : 1);

    // Dash — short speed burst, then cooldown
    if (this.dashTimer > 0) {
      this.dashTimer -= delta;
      speed = this.dashSpeed;
      if (this.dashTimer <= 0) {
        this.dashCooldown = this.dashCooldownMax;
      }
    }
    if (this.dashCooldown > 0) this.dashCooldown -= delta;

    // Horizontal movement
    this.direction.set(0, 0, 0);
    const forward = this._tmpForward;
    const right = this._tmpRight;
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, this._tmpUp).normalize();

    // Keyboard input
    if (this.moveForward) this.direction.add(forward);
    if (this.moveBackward) this.direction.sub(forward);
    if (this.moveRight) this.direction.add(right);
    if (this.moveLeft) this.direction.sub(right);

    // Gamepad left stick input (additive with keyboard)
    if (useGamepad && (this.gamepadMoveX !== 0 || this.gamepadMoveY !== 0)) {
      this.direction.x += right.x * this.gamepadMoveX - forward.x * this.gamepadMoveY;
      this.direction.y += right.y * this.gamepadMoveX - forward.y * this.gamepadMoveY;
      this.direction.z += right.z * this.gamepadMoveX - forward.z * this.gamepadMoveY;
    }

    // Touch virtual joystick input
    if (this.touchEnabled && (this.touchMoveX !== 0 || this.touchMoveY !== 0)) {
      this.direction.x += right.x * this.touchMoveX - forward.x * this.touchMoveY;
      this.direction.y += right.y * this.touchMoveX - forward.y * this.touchMoveY;
      this.direction.z += right.z * this.touchMoveX - forward.z * this.touchMoveY;
    }

    this.direction.normalize();

    const moveDist = speed * delta;
    const newX = this.camera.position.x + this.direction.x * moveDist;
    const newZ = this.camera.position.z + this.direction.z * moveDist;

    // Check collisions
    let blocked = false;
    if (colliders && colliders.length > 0) {
      const playerRadius = 0.4;
      const checkY = this.camera.position.y - this.playerHeight / 2;
      const checkPoint = this._tmpCheckPoint;
      checkPoint.set(newX, checkY, newZ);
      for (let i = 0, n = colliders.length; i < n; i++) {
        const b = colliders[i].box || colliders[i];
        if (!b || !b.min) continue;
        // Inlined expanded box containsPoint test
        if (checkPoint.x >= b.min.x - playerRadius && checkPoint.x <= b.max.x + playerRadius &&
            checkPoint.y >= b.min.y - playerRadius && checkPoint.y <= b.max.y + playerRadius &&
            checkPoint.z >= b.min.z - playerRadius && checkPoint.z <= b.max.z + playerRadius) {
          blocked = true;
          break;
        }
      }
    }

    if (!blocked) {
      this.camera.position.x = newX;
      this.camera.position.z = newZ;
    }

    // Keep within level bounds
    const bound = this.bound || 95;
    this.camera.position.x = Math.max(-bound, Math.min(bound, this.camera.position.x));
    this.camera.position.z = Math.max(-bound, Math.min(bound, this.camera.position.z));

    // Vertical (gravity + jump)
    this.verticalVelocity -= this.gravity * delta;
    this.camera.position.y += this.verticalVelocity * delta;

    if (this.camera.position.y <= this.playerHeight) {
      this.camera.position.y = this.playerHeight;
      this.verticalVelocity = 0;
      this.onGround = true;
    }

    // Head bob — sine wave on Y driven by horizontal movement speed
    const hSpeed = this.direction.length() * speed;
    if (hSpeed > 0.5 && this.onGround && this.dashTimer <= 0) {
      const rate = this.sprint ? 14 : 10;
      const amp = this.sprint ? 0.06 : 0.035;
      this.headBobPhase += delta * rate;
      this.headBobAmount += (amp - this.headBobAmount) * 8 * delta;
      this.camera.position.y += Math.sin(this.headBobPhase) * this.headBobAmount;
    } else {
      this.headBobAmount *= Math.max(0, 1 - 8 * delta);
      if (this.headBobAmount > 0.001) {
        this.camera.position.y += Math.sin(this.headBobPhase) * this.headBobAmount;
      }
    }
  }

  getPosition() {
    return this.camera.position;
  }

  getDirection(target) {
    const dir = target || new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return dir;
  }
}
