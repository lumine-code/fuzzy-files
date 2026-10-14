// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [],
  viewport: { width: 1100, height: 720 },
  async before() {},
  async prepare(context) {
    const { state, open } = context;
    state.editor = await open("signal.js");
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Find a project file by name.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, waitFor } = context;
        {
          lumine.commands.dispatch(lumine.views.getView(state.editor), "fuzzy-files:toggle");
          await waitFor(
            () => lumine.workspace.getModalPanels().some((p) => p.isVisible()),
            "action picker",
          );
          const input = lumine.workspace
            .getModalPanels()
            .find((p) => p.isVisible())
            .getElement()
            .querySelector("lumine-text-editor[mini]");
          if (!input) throw new Error("Missing picker input");
          input.getModel().setText("signal");
        }
      },
      ready(context) {
        const { lumine } = context;
        return Boolean(lumine.workspace.getModalPanels().some((panel) => panel.isVisible()));
      },
    },
  ],
  async cleanup() {},
};
