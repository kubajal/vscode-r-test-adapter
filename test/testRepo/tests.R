
addition <- function(a, b) a + b
division <- function(a, b) a / b

## specs
describe("math library", {
  describe("addition()", {
    it("can add two numbers", {
      expect_equal(1 + 1, addition(1, 1))
      expect_equal(1 + 111, addition(1, 1))
    })
  })
  describe("division()", {
    it("can divide two numbers", {
      expect_equal(10 / 2, division(10, 2))
    })
    it("can handle division by 0") #not yet implemented
  })
})
