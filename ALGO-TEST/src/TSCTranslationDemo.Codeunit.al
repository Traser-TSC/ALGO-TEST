codeunit 100000 "TSC Translation Demo Mgt."
{
    procedure ValidateEntry(DemoEntry: Record "TSC Translation Demo")
    var
        BlockedErr: Label 'The demo entry %1 is blocked and cannot be processed.', Comment = '%1 = the code of the demo entry';
        DescriptionMissingErr: Label 'Enter a description before you process the demo entry.';
    begin
        if DemoEntry.Blocked then
            Error(BlockedErr, DemoEntry."Code");

        if DemoEntry.Description = '' then
            Error(DescriptionMissingErr);
    end;
}
