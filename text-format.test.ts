import { describe, expect, test } from "bun:test"
import { normalizeTrailingColon } from "./text-format"

describe("normalizeTrailingColon", () => {
  test("替换中文和英文句尾冒号", () => {
    expect(normalizeTrailingColon("继续验证：")).toBe("继续验证。")
    expect(normalizeTrailingColon("continue:")).toBe("continue。")
  })

  test("保留正文内部冒号和其他句尾", () => {
    expect(normalizeTrailingColon("状态：成功")).toBe("状态：成功")
    expect(normalizeTrailingColon("已经完成！")).toBe("已经完成！")
    expect(normalizeTrailingColon("结果如下：\n- 第一项")).toBe("结果如下：\n- 第一项")
  })
})
