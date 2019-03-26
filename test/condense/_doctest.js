/**
 * @typedef {Object} SomeOtherDef
 * @property {number} [left]
 * @property {number} [right]
 */

/**
 * Parameter description
 * @typedef {Object} SomeDef
 * @property {(string|SomeOtherDef)} [border="Hallo"] - World limitations when using Physics. Values are "bowl", "border", "box" or "none"
 * @property {number|string} [width] - Width of the stage canvas in pixels
 * @property {number} [height] - Height of the stage canvas in pixels
 */

/**
 * @callback MyCallback
 * @param {string} event
 */

class SomeBase {
    constructor() {}
}

class Test extends SomeBase {
    /**
     * @param {string} [eventName] - Eventname
     * @param {(string|number)} [doubleThing]
     * @param {SomeDef} [options] - Options
     */
    constructor(eventName, doubleThing, options) {
        super();
    }

    /**
     *
     * @param {MyCallback} callback
     */
    onClick(callback) {}

}
