import { expect, test } from "bun:test";
import { domainOf, nameOf } from "./domain";

test("plain domains are addresses", () => {
  expect(domainOf("vercel.com")).toBe("vercel.com");
  expect(domainOf("microsoft.com")).toBe("microsoft.com");
  expect(domainOf("Vercel.COM")).toBe("vercel.com");
  expect(domainOf("  vercel.com  ")).toBe("vercel.com");
});

test("what is around the domain is discarded", () => {
  expect(domainOf("https://posthog.com")).toBe("posthog.com");
  expect(domainOf("http://www.acme.co.uk/pricing?ref=x#top")).toBe("www.acme.co.uk");
  expect(domainOf("acme.com/pricing")).toBe("acme.com");
});

test("a domain being typed is not one yet", () => {
  // Every prefix of `acme.com`, none of which should cost a fetch.
  for (const half of ["a", "ac", "acme", "acme.", "acme.c"]) expect(domainOf(half)).toBeNull();
  expect(domainOf("acme.com")).toBe("acme.com");
});

test("things that are not sites", () => {
  expect(domainOf("")).toBeNull();
  expect(domainOf("   ")).toBeNull();
  expect(domainOf("acme corp.com")).toBeNull();
  expect(domainOf("localhost")).toBeNull();
  expect(domainOf("1.5")).toBeNull();
  expect(domainOf("e.g")).toBeNull();
  expect(domainOf("mailto:hi@acme.com")).toBeNull();
  expect(domainOf("data:text/html,x")).toBeNull();
  expect(domainOf("http://[::1]/")).toBeNull();
  expect(domainOf("acme_corp.com")).toBeNull();
  expect(domainOf("-acme.com")).toBeNull();
});

test("long and unusual tlds are still tlds", () => {
  expect(domainOf("studio.photography")).toBe("studio.photography");
  expect(domainOf("my-site.io")).toBe("my-site.io");
});

test("an idn comes back punycoded", () => {
  expect(domainOf("münchen.de")).toBe("xn--mnchen-3ya.de");
});

test("a name is the host without its www, capped", () => {
  expect(nameOf("www.acme.com", 24)).toBe("acme.com");
  expect(nameOf("blog.acme.com", 24)).toBe("blog.acme.com");
  expect(nameOf("averylongdomainnameindeed.com", 10)).toBe("averylongd");
});

test("a port is not a scheme", () => {
  expect(domainOf("acme.com:8080")).toBe("acme.com");
});
