fn main(x: u32, y: u32, z: pub u32) { assert(x + y == z); }
#[test]
fn valid_sum() { main(2, 3, 5); }
#[test(should_fail)]
fn invalid_sum() { main(2, 3, 6); }

