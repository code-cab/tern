class Test {
  onClick(callback) {}
}

var t = new Test();
t.onClick(function() {
  this //: Test2
});
