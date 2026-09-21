const path = require("path");

const PACKAGE_NAME = "fuzzy-files";
const PACKAGE_PATH = path.join(__dirname, "..");

describe("fuzzy-files bootstrap activation", () => {
  let pack;
  let workspaceElement;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded(PACKAGE_NAME)) {
      await lumine.packages.unloadPackage(PACKAGE_NAME);
    }
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    pack = await lumine.packages.startPackage(PACKAGE_PATH);
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded(PACKAGE_NAME)) {
      await lumine.packages.unloadPackage(PACKAGE_NAME);
    }
  });

  it("activates its command facade before the finder is opened", () => {
    expect(lumine.packages.getPackageLifecycleState(PACKAGE_NAME)).toBe("active");
    expect(pack.mainModule).not.toBeNull();
    expect(pack.mainActivated).toBe(true);
    expect(pack.mainModule.selectListHost).toBeNull();
  });

  it("creates the finder when its command is used", async () => {
    await lumine.commands.dispatch(workspaceElement, "fuzzy-files:toggle");

    expect(lumine.packages.getPackageLifecycleState(PACKAGE_NAME)).toBe("active");
    expect(pack.mainActivated).toBe(true);
    expect(pack.mainModule.selectListHost.isVisible()).toBe(true);
    pack.mainModule.selectListHost.hide();
  });
});
