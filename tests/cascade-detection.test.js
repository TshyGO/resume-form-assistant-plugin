const test = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../ai-helpers.js");

function createMockElement(tagName, optionsCount = 2, attributes = {}) {
  const el = {
    tagName: tagName.toUpperCase(),
    parentElement: null,
    options: new Array(optionsCount).fill({}),
    getAttribute(name) {
      return attributes[name] || null;
    },
    contains(child) {
      let current = child;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    }
  };
  return el;
}

function createMockContainer(children) {
  const container = createMockElement("div");
  children.forEach(child => {
    child.parentElement = container;
  });
  return container;
}

test("检测级联：基于名称包含地域关键词", () => {
  const select1 = createMockElement("select", 3);
  const select2 = createMockElement("select", 3);
  
  createMockContainer([select1, select2]);

  const fields = [
    { fieldId: "f1", tagName: "select", name: "province", idAttr: "", ariaLabel: "", options: [{},{},{}] },
    { fieldId: "f2", tagName: "select", name: "city", idAttr: "", ariaLabel: "", options: [{},{},{}] }
  ];

  const fieldMap = new Map([
    ["f1", { element: select1 }],
    ["f2", { element: select2 }]
  ]);

  helpers.detectCascadeGroups(fields, fieldMap);

  assert.equal(fields[0].cascadeGroup, "group-0");
  assert.equal(fields[0].cascadeLevel, 0);
  assert.equal(fields[1].cascadeGroup, "group-0");
  assert.equal(fields[1].cascadeLevel, 1);
});

test("检测级联：后一个 select 只有不到 2 个 options", () => {
  const select1 = createMockElement("select", 5);
  const select2 = createMockElement("select", 1); // Only 1 option
  const select3 = createMockElement("select", 0); // No options
  
  createMockContainer([select1, select2, select3]);

  const fields = [
    { fieldId: "f3", tagName: "select", name: "dept1", idAttr: "", ariaLabel: "", options: [{},{},{},{},{}] },
    { fieldId: "f4", tagName: "select", name: "dept2", idAttr: "", ariaLabel: "", options: [{}] },
    { fieldId: "f5", tagName: "select", name: "dept3", idAttr: "", ariaLabel: "", options: [] }
  ];

  const fieldMap = new Map([
    ["f3", { element: select1 }],
    ["f4", { element: select2 }],
    ["f5", { element: select3 }]
  ]);

  helpers.detectCascadeGroups(fields, fieldMap);

  assert.equal(fields[0].cascadeGroup, "group-0");
  assert.equal(fields[0].cascadeLevel, 0);
  assert.equal(fields[1].cascadeLevel, 1);
  assert.equal(fields[2].cascadeLevel, 2);
});

test("非级联：没有关键词，所有选项都大于 2", () => {
  const select1 = createMockElement("select", 5);
  const select2 = createMockElement("select", 5);
  
  createMockContainer([select1, select2]);

  const fields = [
    { fieldId: "f6", tagName: "select", name: "skill", idAttr: "", ariaLabel: "", options: [{},{},{},{},{}] },
    { fieldId: "f7", tagName: "select", name: "hobby", idAttr: "", ariaLabel: "", options: [{},{},{},{},{}] }
  ];

  const fieldMap = new Map([
    ["f6", { element: select1 }],
    ["f7", { element: select2 }]
  ]);

  helpers.detectCascadeGroups(fields, fieldMap);

  assert.equal(fields[0].cascadeGroup, undefined);
  assert.equal(fields[1].cascadeGroup, undefined);
});

test("混合场景：页面上有多组级联", () => {
  const select1 = createMockElement("select", 3);
  const select2 = createMockElement("select", 0);
  const container1 = createMockContainer([select1, select2]);

  const select3 = createMockElement("select", 3);
  const select4 = createMockElement("select", 0);
  const container2 = createMockContainer([select3, select4]);

  createMockContainer([container1, container2]); // Common wrapper, but parent match handles properly

  const fields = [
    { fieldId: "f8", tagName: "select", name: "grp1_dropdown1", ariaLabel: "", options: [{},{},{}] },
    { fieldId: "f9", tagName: "select", name: "grp1_dropdown2", ariaLabel: "", options: [] },
    { fieldId: "f10", tagName: "select", name: "grp2_dropdown1", ariaLabel: "", options: [{},{},{}] },
    { fieldId: "f11", tagName: "select", name: "grp2_dropdown2", ariaLabel: "", options: [] }
  ];

  const fieldMap = new Map([
    ["f8", { element: select1 }],
    ["f9", { element: select2 }],
    ["f10", { element: select3 }],
    ["f11", { element: select4 }]
  ]);

  helpers.detectCascadeGroups(fields, fieldMap);

  assert.equal(fields[0].cascadeGroup, "group-0");
  assert.equal(fields[1].cascadeGroup, "group-0");
  assert.equal(fields[2].cascadeGroup, "group-1");
  assert.equal(fields[3].cascadeGroup, "group-1");
});
