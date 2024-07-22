const fs = require('fs');
const path = require("path");
const crypto = require("crypto");

function getCardImage(images){
    let image = null;
    if (images?.["png"]){
        image = images["png"];
    } else if (images?.["large"]){
        image = images["large"];
    } else if (images?.["normal"]){
        image = images["normal"];
    } else if (images?.["small"]){
        image = images["small"];
    } else if (images?.["border_crop"]){
        image = images["border_crop"];
    } else {
        image = images?.[Object.keys(images)?.[0]] ?? null;
    }
    return image;
}

function getArtCrop(images){
    let image = null;
    if (images?.["art_crop"]){
        image = images["art_crop"];
    }
    return image;
}

function buildCardData(data){
    const card = {
        oracleId: data["oracle_id"],
        date: data["released_at"],
        name: data["name"],
        layout: data["layout"],
        colors: data?.["colors"] || data?.["color_identity"] || [],
        legalities: data?.["legalities"] ?? [],
        rarity: data?.["rarity"] ?? null,
        keywords: data?.["keywords"] ?? [],
        front: null,
        back: null,
        type: null,
        subtypes: [],
        texts: [],
        manaCosts: [],
        totalManaCost: 0,
        faceNames: [],
        flavorTexts: [],
        toughness: 0,
        power: 0,
        art: null,
        price: null,
        tix: null,
        set: null,
        edhRank: null,
    };

    for (const legalitie in card.legalities){
        if (card.legalities[legalitie] === "legal"){
            card.legalities[legalitie] = true;
        } else {
            card.legalities[legalitie] = false;
        }
    }

    if (data?.["card_faces"]?.length){
        for (let i = 0; i < data["card_faces"].length; i++){
            if ("type_line" in data["card_faces"][i]){
                const types = data["card_faces"][i]?.["type_line"]?.split("—") ?? [];
                if (types.length){
                    if (!card.type){
                        card.type = types[0].trim();
                    }
                    for (let i = 1; i < types.length; i++){
                        card.subtypes.push(types[i].trim());
                    }
                }
            }
            if (data["card_faces"][i]?.["oracle_text"]){
                card.texts.push(data["card_faces"][i]["oracle_text"]);
        }
            if (data["card_faces"][i]?.["mana_cost"]){
                card.manaCosts.push(data["card_faces"][i]["mana_cost"]);
                if (i === 0){
                    const manaValues = data["card_faces"][i]["mana_cost"].match(/\d|R|U|B|G|W|S/g);
                    if (manaValues){
                        for (let i = 0; i < manaValues.length; i++){
                            const value = parseInt(manaValues[i]);
                            if (!isNaN(value)){
                                card.totalManaCost += value;
                            } else {
                                card.totalManaCost += 1;
                            }
                        }
                    }
                }
            }
            if (data["card_faces"][i]?.["name"]){
                card.faceNames.push(data["card_faces"][i]["name"]);
            }
            if (data["card_faces"][i]?.["flavor_text"]){
                card.flavorTexts.push(data["card_faces"][i]["flavor_text"]);
            }
            if (data["card_faces"][i]?.["toughness"] && data["card_faces"][i]?.["power"]){
                card.power = data["card_faces"][0]["power"];
                card.toughness = data["card_faces"][0]["toughness"];
            }
        }
        if (["modal_dfc", "transform"].includes(data["layout"])){
            card.front = getCardImage(data["card_faces"][0]?.["image_uris"] ?? {});
            card.back = getCardImage(data["card_faces"][1]?.["image_uris"] ?? {});
            card.art = getArtCrop(data["card_faces"][0]?.["image_uris"] ?? {});
        } else {
            card.front = getCardImage(data?.["image_uris"] ?? {});
            card.back = getCardImage(data?.["image_uris"] ?? {});
            card.art = getArtCrop(data?.["image_uris"] ?? {});
        }
    } else {
        card.front = getCardImage(data?.["image_uris"] ?? {});
        card.art = getArtCrop(data?.["image_uris"] ?? {});
        if (data?.["oracle_text"]){
            card.texts.push(data["oracle_text"]);
        }
        if (data?.["mana_cost"]){
            card.manaCosts.push(data["mana_cost"]);
        }
        if (data?.["name"]){
            card.faceNames.push(data["name"]);
        }
        if (data?.["flavor_text"]){
            card.flavorTexts.push(data["flavor_text"]);
        }
        if (data?.["power"] && data?.["toughness"]){
            card.power = data["power"];
            card.toughness = data["toughness"];
        }
        const types = data?.["type_line"]?.split("—") ?? [];
        if (types.length){
            card.type = types[0].trim();
            for (let i = 1; i < types.length; i++){
                card.subtypes.push(types[i].trim());
            }
        }
        const manaValues = data["mana_cost"].match(/\d|R|U|B|G|W|S/g);
        if (manaValues){
            for (let i = 0; i < manaValues.length; i++){
                const value = parseInt(manaValues[i]);
                if (!isNaN(value)){
                    card.totalManaCost += value;
                } else {
                    card.totalManaCost += 1;
                }
            }
        }
    }

    if (data?.["prices"]?.["usd"] !== null) {
        card.price = parseFloat(data?.["prices"]?.["usd"]) * 100;
    }
    if (data?.["prices"]?.["tix"] !== null) {
        card.tix = parseFloat(data?.["prices"]?.["tix"]) * 100;
    }

    if (data?.["set_name"]) {
        card.set = data["set_name"];
    }

    if (data?.["edhrec_rank"]) {
        card.edhRank = data["edhrec_rank"];
    }

    return card;
}

module.exports = async (scryfallData, outDir, count) => {    

    console.log(`Processing card #${count}: ${scryfallData.name}`);

    let existingCard = null;
    let card = buildCardData(scryfallData);

    if (!card.front){
        return;
    }

    const cardFile = path.join(outDir, card.oracleId, "card.json");

    const cleanName = card.name.trim().toLowerCase().replace(/[^a-z0-9-_\s]/gi, "").replace(/\s+/g, " ");
    const hash = crypto.createHash("md5").update(cleanName).digest("hex");

    if (!fs.existsSync(path.join(outDir, card.oracleId))){
        await fs.promises.mkdir(path.join(outDir, card.oracleId));
    }

    fs.appendFileSync(path.join(outDir, card.oracleId, "front-images"), `${card.date}|${card.front}\n`);
    if (card.back) {
        fs.appendFileSync(path.join(outDir, card.oracleId, "back-images"), `${card.date}|${card.back}\n`);
    }

    if (fs.existsSync(cardFile)) {
        existingCard = await fs.promises.readFile(cardFile, { encoding: "utf8" });
        existingCard = JSON.parse(existingCard);
        const newCardReleased = Date.parse(card.date);
        const oldCardReleased = Date.parse(existingCard.date);

        let updatedPrice = false
        if (existingCard.price === null && card.price !== null) {
            existingCard.price = card.price;
            updatedPrice = true;
        }
        else if (card.price === null && existingCard.price !== null) {
            card.price = existingCard.price;
        }

        if (existingCard.price > card.price) {
            existingCard.price = card.price;
            updatedPrice = true;
        }

        if (existingCard.price < card.price) {
            card.price = existingCard.price;
        }

        if (existingCard.tix === null && card.tix !== null) {
            existingCard.tix = card.tix;
            updatedPrice = true;
        }
        else if (card.tix === null && existingCard.tix !== null) {
            card.tix = existingCard.tix;
        }

        if (existingCard.tix > card.tix) {
            existingCard.tix = card.tix;
            updatedPrice = true;
        }

        if (existingCard.tix < card.tix) {
            card.tix = existingCard.tix;
        }

        if (oldCardReleased > newCardReleased) {
            if (updatedPrice) {
                await fs.promises.unlink(cardFile);
                await fs.promises.writeFile(cardFile, JSON.stringify(existingCard));
            }
            return;
        }
    }   

    if (fs.existsSync(cardFile)){
        await fs.promises.unlink(cardFile);
    }

    card.dir = path.join(outDir, card.oracleId);
    card.id = hash;

    await fs.promises.writeFile(cardFile, JSON.stringify(card));

    return;
}
