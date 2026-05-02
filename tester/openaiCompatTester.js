var win = nw.Window.get();
var addon = window.opener.addonLoader.getAddon("transOpenAICompat") || window.opener.addonLoader.addons.transOpenAICompat;
var engine = window.opener.trans.getTranslatorEngine("transOpenAICompat");

class OpenAICompatTester extends require("www/js/BasicEventHandler.js") {
    constructor() {
        super();
        this.$source = $("#sourceText");
        this.$translated = $("#translatedText");
        this.$log = $("#logText");
    }
}

OpenAICompatTester.prototype.log = function(message) {
    const previous = this.$log.val();
    this.$log.val(`${previous}${previous ? "\n" : ""}${message}`);
};

OpenAICompatTester.prototype.translate = async function() {
    loadingScreen.show();
    try {
        this.log("Running sample translation...");
        const output = await addon.translateSample(this.$source.val());
        this.$translated.val(output);
        this.log("Sample translation completed.");
    } catch (error) {
        console.error(error);
        this.log(`Error: ${error.message}`);
        alert(error.message);
    } finally {
        loadingScreen.hide();
    }
};

OpenAICompatTester.prototype.testConnection = async function() {
    loadingScreen.show();
    try {
        this.log("Testing connection...");
        const result = await engine.testConnection();
        this.log(`Connection OK: ${result.models.length} models, ${result.elapsed} ms`);
    } catch (error) {
        console.error(error);
        this.log(`Connection test failed: ${error.message}`);
        alert(error.message);
    } finally {
        loadingScreen.hide();
    }
};

OpenAICompatTester.prototype.listModels = async function() {
    loadingScreen.show();
    try {
        this.log("Listing models...");
        const models = await engine.fetchAvailableModels();
        this.log(models.join(", "));
        alert(models.join("\n") || "No models returned.");
    } catch (error) {
        console.error(error);
        this.log(`List models failed: ${error.message}`);
        alert(error.message);
    } finally {
        loadingScreen.hide();
    }
};

$(document).ready(function() {
    window.loadingScreen = new LoadingScreen();
    window.tester = new OpenAICompatTester();

    $(".button-translate").on("click", function() {
        tester.translate();
    });
    $(".button-test").on("click", function() {
        tester.testConnection();
    });
    $(".button-models").on("click", function() {
        tester.listModels();
    });
    $(".button-debugger").on("click", function() {
        win.showDevTools();
    });

    tester.$source.val([
        "\\N[1]「……ここはどこだ？」",
        "村人A「北の森には魔王軍がいるらしいよ。」",
        "選択肢: 行く / 行かない"
    ].join("\n"));
});
