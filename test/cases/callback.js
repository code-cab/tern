/**
 * @callback MyCallback
 * @param {string} Eventje - Some event
 * @this {Test}
 */

class Test {
    /**
     * @param {MyCallback} callback
     */
  onClick(callback) {
  }
}

var t = new Test();
/**
 * onClick here
 */
t.onClick(function(ev) {
  this //: Test
});
