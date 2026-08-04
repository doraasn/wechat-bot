import { describe, expect, test } from "bun:test"
import { assertSendMessageResponse } from "./ilink-client"

describe("assertSendMessageResponse", () => {
  test("接受微信成功回执", () => {
    expect(() => assertSendMessageResponse({ ret: 0, errcode: 0 })).not.toThrow()
  })

  test("拒绝 HTTP 200 中的业务错误", () => {
    expect(() => assertSendMessageResponse({ ret: 1, errcode: 45009, errmsg: "rate limited" }))
      .toThrow("ret=1 errcode=45009")
  })
})
